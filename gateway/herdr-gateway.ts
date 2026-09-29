// Herdr ChatGPT gateway. Runs on the Mac as the forced command of the bridge SSH key.
//
// Protocol: newline-delimited JSON on stdin, one response line per request on stdout.
//   request:  {"id": "...", "op": "list_agents", "params": {...}}
//   response: {"id": "...", "ok": true, "result": ...}
//             {"id": "...", "ok": false, "error": {"code": "...", "message": "..."}}
//
// Every operation is a named, typed Herdr socket API call. Nothing here builds a
// shell command line; raw pane execution is a separate capability, off by default.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GatewayError, loadConfig, type GatewayConfig } from "./config.ts";
import { Gateway } from "./gateway.ts";
import { herdrSocket } from "./herdr-socket.ts";
import { StateStore } from "./state.ts";

// Fields worth keeping in the audit log. Commands are kept in full-ish: with exec
// on, the log is the record of what ran.
const AUDIT_FIELDS = ["target", "pane_id", "repo", "task", "kind", "id", "name", "path", "from", "to", "cwd", "workspace_id", "tab_id", "branch"];

function auditDetail(params: Record<string, any>) {
  const d: Record<string, unknown> = {};
  for (const k of AUDIT_FIELDS) if (typeof params[k] === "string") d[k] = params[k].slice(0, 300);
  if (typeof params.command === "string") d.command = params.command.slice(0, 2000);
  for (const k of ["text", "prompt"]) if (typeof params[k] === "string") d[k] = params[k].slice(0, 300);
  // The menu option answer_agent picked.
  for (const k of ["option", "options"]) if (params[k] !== undefined) d[k] = params[k];
  return d;
}

function audit(cfg: GatewayConfig | undefined, entry: Record<string, unknown>) {
  if (cfg) new StateStore(cfg.stateDir).audit(entry);
}

function respond(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function main() {
  const configPath = process.env.HERDR_GATEWAY_CONFIG ?? resolve(process.env.HOME ?? "/", ".config/herdr-chatgpt/gateway.json");
  let cfg: GatewayConfig;
  try {
    cfg = loadConfig(JSON.parse(readFileSync(configPath, "utf8")));
  } catch (err) {
    respond({ id: null, ok: false, error: { code: "config_error", message: (err as Error).message } });
    process.exit(78);
  }
  if (process.env.SSH_ORIGINAL_COMMAND) {
    audit(cfg, { op: "ssh_command_ignored", ok: true, command: process.env.SSH_ORIGINAL_COMMAND.slice(0, 200) });
  }
  const gateway = new Gateway(cfg, herdrSocket(cfg.herdrSocketPath));
  // Room for a write_file of maxFileBytes after JSON escaping.
  const maxLine = Math.max(256 * 1024, cfg.maxFileBytes * 2 + 64 * 1024);

  let handled = 0;
  let buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    if (buf.length > maxLine && !buf.includes("\n")) {
      respond({ id: null, ok: false, error: { code: "request_too_large", message: "request line too large" } });
      process.exit(65);
    }
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) {
        handled++;
        await handleLine(gateway, cfg, line);
      }
    }
  }
  if (buf.trim()) {
    handled++;
    await handleLine(gateway, cfg, buf.trim());
  }
  if (handled === 0) {
    respond({ id: null, ok: false, error: { code: "empty_input", message: "expected one JSON request per line on stdin" } });
    process.exit(65);
  }
}

async function handleLine(gateway: Gateway, cfg: GatewayConfig, line: string) {
  let req: any;
  try {
    req = JSON.parse(line);
  } catch {
    audit(cfg, { op: null, ok: false, code: "invalid_json" });
    return respond({ id: null, ok: false, error: { code: "invalid_json", message: "request is not valid JSON" } });
  }
  const id = typeof req?.id === "string" || typeof req?.id === "number" ? req.id : null;
  const op = req?.op;
  const params = req?.params && typeof req.params === "object" && !Array.isArray(req.params) ? req.params : {};
  const started = Date.now();
  try {
    if (typeof op !== "string") throw new GatewayError("invalid_request", "op must be a string");
    const result: any = await gateway.request(op, params);
    // The notifier polls every few seconds; only polls that found something are worth a line.
    if (op !== "watch_poll" || result?.messages?.length) audit(cfg, { id, op, ok: true, args: auditDetail(params), ms: Date.now() - started });
    respond({ id, ok: true, result: gateway.mask.result(op, result, params.target ?? params.pane_id) });
  } catch (err) {
    const e = err instanceof GatewayError ? err : new GatewayError("internal_error", (err as Error).message ?? String(err));
    audit(cfg, { id, op: typeof op === "string" ? op.slice(0, 64) : null, ok: false, code: e.code, args: auditDetail(params), ms: Date.now() - started });
    respond({ id, ok: false, error: { code: e.code, message: gateway.mask.text(e.message) } });
  }
}

if (import.meta.main) {
  await main();
}
