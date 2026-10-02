import { describe, expect, test } from "bun:test";
import { hostAllowed } from "../src/provider.ts";

const hosts = ["chatgpt.com", "openai.com"];

describe("which client URLs are fetched or redirected to", () => {
  test("https URLs on the allowed hosts and their subdomains pass", () => {
    expect(hostAllowed(hosts, "https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(hostAllowed(hosts, "https://platform.openai.com/client.json")).toBe(true);
  });

  test("lookalikes, other schemes, private addresses and junk are refused", () => {
    for (const u of [
      "http://chatgpt.com/x", "https://evilchatgpt.com/x", "https://chatgpt.com.evil.example/x", "https://evil.example/chatgpt.com",
      "https://user@evil.example@chatgpt.com.evil.example/", "https://127.0.0.1/x", "https://169.254.169.254/latest", "javascript:alert(1)", "not a url", "",
    ]) expect(hostAllowed(hosts, u)).toBe(false);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportJWK } from "jose";
import { loadConfig } from "../src/config.ts";

describe("clients.json", () => {
  async function dirWith(clients?: unknown) {
    const dir = mkdtempSync(join(tmpdir(), "issuer-cfg-"));
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    writeFileSync(join(dir, "signing-key.json"), JSON.stringify(await exportJWK(privateKey)));
    writeFileSync(join(dir, "cookie-keys.json"), JSON.stringify(["x".repeat(40)]));
    writeFileSync(join(dir, "password-hash"), "scrypt$x");
    if (clients !== undefined) writeFileSync(join(dir, "clients.json"), JSON.stringify(clients));
    return dir;
  }
  const env = (dir: string) => ({ ISSUER_DIR: dir, ISSUER_URL: "https://auth.example.com", MCP_RESOURCE: "https://mcp.example.com/mcp" });

  test("absent means none, a good file loads, and bad ones fail the start", async () => {
    const none = await dirWith();
    expect(loadConfig(env(none)).clients).toEqual([]);
    const ok = await dirWith([{ client_id: "chatgpt-events", redirect_uris: ["https://chatgpt.com/connector/oauth/abc"] }]);
    expect(loadConfig(env(ok)).clients[0]!.client_id).toBe("chatgpt-events");
    const url = await dirWith([{ client_id: "https://chatgpt.com/oauth/client.json", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] }]);
    expect(loadConfig(env(url)).clients[0]!.client_id).toBe("https://chatgpt.com/oauth/client.json");
    rmSync(url, { recursive: true, force: true });
    const bads: string[] = [];
    for (const bad of [{}, [{ client_id: "x", redirect_uris: ["https://a.example/cb"] }], [{ client_id: "good-id", redirect_uris: ["http://a.example/cb"] }], [{ client_id: "good-id", redirect_uris: [] }]]) {
      bads.push(await dirWith(bad));
    }
    for (const d of bads) expect(() => loadConfig(env(d))).toThrow();
    for (const d of [none, ok, ...bads]) rmSync(d, { recursive: true, force: true });
  });
});
