import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEgressPolicy, readCallbackHosts } from "../scripts/events-egress-policy.ts";

const host = "callbacks.openai.com";
const now = new Date("2026-09-30T12:00:00.000Z");

describe("MCP Events systemd egress policy", () => {
  test("adds only resolved public host addresses and retains the deny policy", async () => {
    const resolved: string[] = [];
    const policy = await generateEgressPolicy([host, "other.openai.com", host], async (name) => {
      resolved.push(name);
      return name === host ? ["8.8.8.8", "2606:4700:4700::1111", "8.8.8.8"] : ["1.1.1.1"];
    }, now);
    expect(resolved).toEqual([host, "other.openai.com"]);
    expect(policy.addresses).toEqual(["1.1.1.1", "2606:4700:4700::1111", "8.8.8.8"]);
    expect(policy.dropIn).toContain("IPAddressDeny=any\n");
    expect(policy.dropIn).toContain("IPAddressAllow=\nIPAddressAllow=localhost 100.64.0.0/10 fd7a:115c:a1e0::/48\n");
    expect(policy.dropIn.match(/^IPAddressAllow=.+$/gm)).toEqual([
      "IPAddressAllow=localhost 100.64.0.0/10 fd7a:115c:a1e0::/48",
      "IPAddressAllow=1.1.1.1/32",
      "IPAddressAllow=2606:4700:4700::1111/128",
      "IPAddressAllow=8.8.8.8/32",
    ]);
    expect(policy.dropIn).toContain("# DNS snapshot: 2026-09-30T12:00:00.000Z");
  });

  test.each(["127.0.0.1", "10.0.0.1", "100.100.100.100", "169.254.169.254", "192.0.2.1", "::1", "fc00::1", "2001::1", "2001:db8::1", "3fff::1", "not-an-address"])("rejects a mixed answer containing %s", async (address) => {
    await expect(generateEgressPolicy([host], async () => ["8.8.8.8", address], now)).rejects.toThrow("Non-public destination address");
  });

  test("does not generate a partial policy when a hostname fails resolution", async () => {
    await expect(generateEgressPolicy([host, "other.openai.com"], async (name) => {
      if (name === host) return ["8.8.8.8"];
      throw new Error("DNS resolution failed");
    }, now)).rejects.toThrow("DNS resolution failed");
    await expect(generateEgressPolicy([host], async () => [], now)).rejects.toThrow("No destination addresses");
  });

  for (const hosts of [[], ["*.openai.com"], ["https://callbacks.openai.com/x"], ["callbacks.openai.com:443"], ["localhost"], ["127.0.0.1"], ["8.8.8.8"], ["2606:4700:4700::1111"]]) {
    test(`requires exact public callback hostnames ${JSON.stringify(hosts)}`, async () => {
      await expect(generateEgressPolicy(hosts, async () => ["8.8.8.8"], now)).rejects.toThrow();
    });
  }

  test("reads only configured callback hosts and rejects missing or malformed config", async () => {
    const configPath = join(mkdtempSync(join(tmpdir(), "events-egress-")), "mcp.json");
    writeFileSync(configPath, JSON.stringify({ auth: { issuer: "https://issuer.example" }, events: { callbackHosts: [host] } }));
    expect(await readCallbackHosts(configPath)).toEqual([host]);
    writeFileSync(configPath, JSON.stringify({ events: { callbackHosts: [] } }));
    await expect(readCallbackHosts(configPath)).rejects.toThrow("nonempty events.callbackHosts");
    writeFileSync(configPath, JSON.stringify({ events: { callbackHosts: [42] } }));
    await expect(readCallbackHosts(configPath)).rejects.toThrow("exact hostnames");
    writeFileSync(configPath, '{"auth":{"secret":"do-not-echo"},');
    await expect(readCallbackHosts(configPath)).rejects.toThrow("MCP config is not valid JSON");
  });
});
