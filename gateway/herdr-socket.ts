// Minimal client for Herdr's newline-delimited JSON socket API: one request per
// connection. The call also carries subscribe, for events.subscribe's open stream.

import { GatewayError, type HerdrCall } from "./config.ts";
import { herdrSubscribe, type Subscribe } from "./herdr-events.ts";

export function herdrSocket(socketPath: string): HerdrCall & { subscribe: Subscribe } {
  let seq = 0;
  const call: HerdrCall = (method, params, timeoutMs = 20_000) =>
    new Promise((resolvePromise, reject) => {
      const id = `gw:${process.pid}:${++seq}`;
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new GatewayError("herdr_timeout", `herdr ${method} timed out after ${timeoutMs}ms`)));
        sock?.end();
      }, timeoutMs);
      let sock: { end(): void; write(d: string): number } | undefined;
      Bun.connect({
        unix: socketPath,
        socket: {
          open(s) {
            sock = s;
            s.write(JSON.stringify({ id, method, params }) + "\n");
          },
          data(s, chunk) {
            // Buffer bytes, not strings: a multi-byte character can straddle two chunks.
            chunks.push(chunk);
            if (!chunk.includes(0x0a)) return;
            const bytes = Buffer.concat(chunks);
            // Settle before end(): end() runs the close handler synchronously.
            finish(() => {
              let msg: any;
              try {
                msg = JSON.parse(bytes.subarray(0, bytes.indexOf(0x0a)).toString("utf8"));
              } catch {
                return reject(new GatewayError("herdr_bad_response", "herdr returned invalid JSON"));
              }
              if (msg.error) return reject(new GatewayError(msg.error.code ?? "herdr_error", msg.error.message ?? "herdr error"));
              resolvePromise(msg.result);
            });
            s.end();
          },
          close() {
            finish(() => reject(new GatewayError("herdr_closed", "herdr closed the connection without a response")));
          },
          error(_s, err) {
            finish(() => reject(new GatewayError("herdr_unavailable", err.message)));
          },
        },
      }).catch((err: Error) => finish(() => reject(new GatewayError("herdr_unavailable", err.message))));
    });
  return Object.assign(call, { subscribe: herdrSubscribe(socketPath) });
}
