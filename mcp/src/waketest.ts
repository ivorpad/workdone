// Throwaway experiment: can a card wake ChatGPT without a click? wake_test renders a card
// that sends ui/message on its own after a delay, and reports each step to the server
// through wake_test_log (app-only), so the journal shows whether ChatGPT took it.
// Remove once the watcher card is built or the idea is dropped.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { registerCard } from "./confirm.ts";

// Versioned: ChatGPT caches a card by URI, so a changed card needs a new one.
const URI = "ui://workdone/wake-test-5.html";

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --bg: #fff; --fg: #1a1a1a; --muted: #6b6b6b; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #1f1f1f; --fg: #ececec; --muted: #a0a0a0; } }
  :root[data-theme="dark"] { --bg: #1f1f1f; --fg: #ececec; --muted: #a0a0a0; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
  main { padding: 12px 16px; } .muted { color: var(--muted); }
</style></head>
<body><main><div id="s">Starting…</div><div class="muted" id="d"></div></main>
<script>
  const main = document.querySelector("main");
  let nextId = 1; const waiting = new Map(); let delay = 30; let repeat = 1; let ask = ""; let target = "active";
  const request = (method, params) => { const id = nextId++; parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*"); return new Promise((res, rej) => waiting.set(id, { res, rej })); };
  const notify = (method, params) => parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  const log = (stage, detail) => request("tools/call", { name: "wake_test_log", arguments: { stage, detail: String(detail ?? "").slice(0, 500) } }).catch(() => {});
  addEventListener("message", (e) => {
    if (e.source !== parent) return; const m = e.data; if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message || "error")) : w.res(m.result); return; }
    if (m.method === "ui/notifications/tool-result") { const s = m.params && m.params.structuredContent; if (s && s.delay) delay = s.delay; if (s && s.repeat) repeat = s.repeat; if (s && s.ask) ask = s.ask; if (s && s.target) target = s.target; start(); }
  });
  new ResizeObserver(() => notify("ui/notifications/size-changed", { height: Math.ceil(main.getBoundingClientRect().height) })).observe(main);
  let started = false;
  function start() {
    if (started) return; started = true;
    let n = 0;
    let at = Date.now() + delay * 1000;
    log("armed", "delay " + delay + "s x" + repeat + ", visibility " + document.visibilityState);
    const tick = setInterval(async () => {
      const left = Math.ceil((at - Date.now()) / 1000);
      document.getElementById("s").textContent = left > 0 ? "Wake " + (n + 1) + "/" + repeat + " in " + left + " s, no click needed" : "Sending wake " + (n + 1) + "/" + repeat;
      if (left > 0) return;
      n += 1;
      const late = Math.round((Date.now() - at) / 1000);
      if (n >= repeat) clearInterval(tick); else at = Date.now() + delay * 1000;
      await log("sending", "wake " + n + "/" + repeat + ", " + late + "s late, visibility " + document.visibilityState + ", focus " + document.hasFocus());
      try {
        const r = await request("ui/message", { role: "user", content: [{ type: "text", text: "Wake test " + n + "/" + repeat + ": this message came from the WorkDone card on a timer, with no click. " + (ask ? ask.replaceAll("{n}", String(n)) : "Reply with only: awake " + n) }], _meta: { "openai/message": target === "new" ? { target: "new", send: true } : { target: "active", send: true } } });
        document.getElementById("d").textContent = "Wake " + n + " accepted (" + target + " thread).";
        log("accepted", "wake " + n + " target " + target + " " + JSON.stringify(r));
      } catch (e) {
        document.getElementById("d").textContent = "Wake " + n + " refused: " + e.message;
        log("refused", "wake " + n + " " + e.message);
      }
    }, 1000);
  }
  request("ui/initialize", { appInfo: { name: "workdone-wake-test", version: "0.0.1" }, appCapabilities: {}, protocolVersion: "2026-01-26" })
    .then((init) => { const t = init && init.hostContext && init.hostContext.theme; if (t) document.documentElement.dataset.theme = t; notify("ui/notifications/initialized", {}); log("initialized", JSON.stringify(init && init.hostInfo)); })
    .catch((e) => { document.getElementById("s").textContent = "No MCP Apps host: " + e.message; });
</script></body></html>`;

export function registerWakeTest(server: McpServer, log: (line: string) => void = console.log) {
  registerCard(server, "wake_test", [URI, "ui://workdone/wake-test-4.html", "ui://workdone/wake-test-3.html", "ui://workdone/wake-test-2.html", "ui://workdone/wake-test.html"], { title: "Wake test" }, HTML);
  server.registerTool(
    "wake_test",
    {
      title: "Wake test (experiment)",
      description: "Experiment, only when the user asks for the wake test: shows a card that sends a message into this chat by itself after a delay. After calling it, say in one line when the card will write, and stop. Answer each wake message as it asks.",
      inputSchema: z.object({
        delay_seconds: z.number().int().min(5).max(3600).optional().describe("Seconds before each write (default 30)."),
        repeat: z.number().int().min(1).max(24).optional().describe("How many times the card writes, delay_seconds apart (default 1)."),
        target: z.enum(["active", "new"]).optional().describe("active (default): this chat. new: the card opens a new chat with the message."),
        ask: z.string().max(500).optional().describe("What each wake message asks for; {n} becomes the wake number. Default: reply 'awake n'."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: URI } },
    },
    async ({ delay_seconds, repeat, ask, target }) => {
      const delay = delay_seconds ?? 30;
      const times = repeat ?? 1;
      log(JSON.stringify({ event: "wake_test", stage: "shown", delay, repeat: times }));
      return {
        content: [{ type: "text" as const, text: `The card will write into this chat ${times} time(s), every ${delay} seconds. Answer each wake message exactly as it asks.` }],
        structuredContent: { delay, repeat: times, ask, target: target ?? "active" },
        isError: false,
      };
    },
  );
  server.registerTool(
    "wake_test_log",
    {
      title: "Wake test log",
      description: "Called by the wake test card to report its progress.",
      inputSchema: z.object({ stage: z.string().max(40), detail: z.string().max(500).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ stage, detail }) => {
      log(JSON.stringify({ event: "wake_test", stage, detail }));
      return { content: [{ type: "text" as const, text: "logged" }], isError: false };
    },
  );
}
