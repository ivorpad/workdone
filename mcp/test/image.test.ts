import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parseConfig } from "../src/config.ts";
import type { CallGateway } from "../src/gateway-client.ts";
import { IMAGE_META, IMAGE_URI } from "../src/image.ts";
import { createHandler } from "../src/server.ts";

const target = { user: "ivor", host: "mac.example.ts.net", identityFile: "/k", knownHostsFile: "/kh" };
const cfg = parseConfig({ listen: { host: "127.0.0.1", port: 8787 }, machines: { mac: target, ovh: { ...target, host: "127.0.0.1" } } });

const PNG = "iVBORw0KGgo=";
const calls: Array<[string, string, Record<string, unknown>]> = [];
const fake: CallGateway = async (machine, op, params) => {
  calls.push([machine, op, params]);
  if (op === "screenshot" && machine === "ovh") return { ok: false, error: { code: "capability_disabled", message: "screenshots need macOS" } };
  if (String(params.path).endsWith("big.png")) return { ok: false, error: { code: "too_large", message: "image is 4000000 bytes; the limit is 3000000" } };
  return { ok: true, result: { path: "/Users/ivor/src/tries/shot.png", size: 9, modified: "2026-10-06T07:00:00.000Z", kind: "image", image: { mime: "image/png", data: PNG } } };
};
const handler = createHandler(cfg, fake);

async function client() {
  const c = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
    fetch: async (input, init) => {
      const req = new Request(String(input), init);
      req.headers.set("host", "127.0.0.1:8787");
      return handler(req);
    },
  }));
  return c;
}

describe("show_image", () => {
  test("the model gets the image, the card gets the bytes in _meta only", async () => {
    const c = await client();
    const r = (await c.callTool({ name: "show_image", arguments: { machine: "ovh", path: "~/src/tries/shot.png" } })) as any;
    expect(calls.at(-1)).toEqual(["ovh", "read_file", { path: "~/src/tries/shot.png", as: "image" }]);
    expect(r.isError).toBe(false);
    expect(r.content[1]).toEqual({ type: "image", data: PNG, mimeType: "image/png" });
    expect(r._meta[IMAGE_META]).toEqual({ mime: "image/png", data: PNG });
    expect(r.structuredContent).toEqual({ machine: "ovh", path: "/Users/ivor/src/tries/shot.png", size: 9, mime: "image/png" });
    expect(JSON.stringify(r.structuredContent)).not.toContain(PNG);
    await c.close();
  });

  test("renders on the image card, served with the empty CSP", async () => {
    const c = await client();
    const { tools } = await c.listTools();
    expect(tools.find((t) => t.name === "show_image")!._meta).toEqual({ ui: { resourceUri: IMAGE_URI } });
    const res = await c.readResource({ uri: IMAGE_URI });
    expect(res.contents[0]).toMatchObject({ uri: IMAGE_URI, mimeType: "text/html;profile=mcp-app" });
    expect(res.contents[0]!._meta).toMatchObject({ ui: { csp: { connectDomains: [], resourceDomains: [] } } });
    await c.close();
  });

  test("a gateway refusal comes back as the error, with nothing for the card", async () => {
    const c = await client();
    const r = (await c.callTool({ name: "show_image", arguments: { path: "~/src/tries/big.png" } })) as any;
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error.code).toBe("too_large");
    expect(r._meta?.[IMAGE_META]).toBeUndefined();
    await c.close();
  });

  test("an unknown machine is refused before the gateway", async () => {
    const c = await client();
    const before = calls.length;
    const r = (await c.callTool({ name: "show_image", arguments: { machine: "nas", path: "/x.png" } })) as any;
    expect(JSON.parse(r.content[0].text).error.code).toBe("unknown_machine");
    expect(calls.length).toBe(before);
    await c.close();
  });
});

describe("screenshot", () => {
  test("asks the machine's gateway and shows the result on the image card", async () => {
    const c = await client();
    const r = (await c.callTool({ name: "screenshot", arguments: { machine: "mac" } })) as any;
    expect(calls.at(-1)).toEqual(["mac", "screenshot", {}]);
    expect(r.content[1]).toEqual({ type: "image", data: PNG, mimeType: "image/png" });
    expect(r._meta[IMAGE_META]).toEqual({ mime: "image/png", data: PNG });
    const { tools } = await c.listTools();
    const tool = tools.find((t) => t.name === "screenshot")!;
    expect(tool._meta).toEqual({ ui: { resourceUri: IMAGE_URI } });
    expect(tool.annotations?.readOnlyHint).toBe(false);
    await c.close();
  });

  test("a machine without screenshots returns the gateway's refusal", async () => {
    const c = await client();
    const r = (await c.callTool({ name: "screenshot", arguments: { machine: "ovh" } })) as any;
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error.code).toBe("capability_disabled");
    await c.close();
  });
});

describe("image card", () => {
  const html = readFileSync(new URL("../src/image.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;

  function card() {
    const elements = new Map<string, any>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, { hidden: id !== "loading", textContent: "", src: "", alt: "", onerror: null, getBoundingClientRect: () => ({ height: 100 }) });
      return elements.get(id);
    };
    const sent: any[] = [];
    let receive = (_event: any): void => {};
    const parent = { postMessage: (rpc: any) => { sent.push(rpc); } };
    const blobs: any[] = [];
    runInNewContext(script, {
      document: { getElementById: element, querySelector: () => element("main"), documentElement: { dataset: {} } },
      window: { parent, addEventListener: (_n: string, cb: (e: any) => void) => { receive = cb; } },
      ResizeObserver: class { observe() {} },
      setTimeout: () => 0, clearTimeout: () => {},
      atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
      Blob: class { constructor(public parts: any[], public opts: any) { blobs.push(this); } },
      URL: { createObjectURL: () => "blob:card/1" },
      Uint8Array,
    });
    const result = (params: any) => receive({ source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params } });
    return { element, result, blobs };
  }

  test("draws the image from _meta as a data URL", () => {
    const c = card();
    c.result({ structuredContent: { machine: "mac", path: "/s.png", size: 2048, mime: "image/png" }, _meta: { [IMAGE_META]: { mime: "image/png", data: PNG } } });
    expect(c.element("img").src).toBe(`data:image/png;base64,${PNG}`);
    expect(c.element("img").hidden).toBe(false);
    expect(c.element("caption").textContent).toBe("mac: /s.png · 2 KB");
  });

  test("falls back to a blob URL, then to a message", () => {
    const c = card();
    c.result({ structuredContent: {}, _meta: { [IMAGE_META]: { mime: "image/png", data: PNG } } });
    c.element("img").onerror();
    expect(c.element("img").src).toBe("blob:card/1");
    expect(c.blobs[0].opts).toEqual({ type: "image/png" });
    c.element("img").onerror();
    expect(c.element("img").hidden).toBe(true);
    expect(c.element("error").textContent).toContain("ChatGPT still received it");
  });

  test("shows the error text when there is no image", () => {
    const c = card();
    c.result({ content: [{ type: "text", text: "{\"error\":{\"code\":\"too_large\"}}" }] });
    expect(c.element("error").hidden).toBe(false);
    expect(c.element("error").textContent).toContain("too_large");
  });
});
