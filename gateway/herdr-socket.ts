// Minimal client for Herdr's newline-delimited JSON socket API: one request per
// connection. The call also carries subscribe, for events.subscribe's open stream.

import { GatewayError, type HerdrCall } from "./config.ts";
import { herdrSubscribe, type Subscribe } from "./herdr-events.ts";

// A failure before the request left whole: Herdr acts on a line only once it ends, so
// nothing was delivered, whatever the error code says.
export const unsent = (err: unknown) => err instanceof GatewayError && (err.details as { unsent?: unknown } | undefined)?.unsent === true;

export function herdrSocket(socketPath: string): HerdrCall & { subscribe: Subscribe } {
  let seq = 0;
  const call: HerdrCall = (method, params, timeoutMs = 20_000) =>
    new Promise((resolvePromise, reject) => {
      const id = `gw:${process.pid}:${++seq}`;
      // write() takes what fits in the socket buffer (8 KB on a macOS Unix socket) and
      // returns how much: drain sends the rest. A long prompt is bigger than that.
      const request = Buffer.from(JSON.stringify({ id, method, params }) + "\n");
      let written = 0;
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      // Short of the JSON's last byte, Herdr can't have parsed it. The newline alone
      // missing could still be read as a request at EOF, so that counts as sent.
      const failure = (code: string, message: string) =>
        written < request.length - 1
          ? new GatewayError(code, `${message}; the request was not sent whole (${written} of ${request.length} bytes), so nothing was delivered`, { unsent: true })
          : new GatewayError(code, message);
      const flush = (s: { write(d: Uint8Array): number }) => {
        while (written < request.length) {
          const n = s.write(request.subarray(written));
          if (n <= 0) return;
          written += n;
        }
      };
      const timer = setTimeout(() => {
        finish(() => reject(failure("herdr_timeout", `herdr ${method} timed out after ${timeoutMs}ms`)));
        sock?.end();
      }, timeoutMs);
      let sock: { end(): void; write(d: Uint8Array): number } | undefined;
      Bun.connect({
        unix: socketPath,
        socket: {
          open(s) {
            sock = s;
            flush(s);
          },
          drain(s) {
            flush(s);
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
            finish(() => reject(failure("herdr_closed", "herdr closed the connection without a response")));
          },
          error(_s, err) {
            finish(() => reject(failure("herdr_unavailable", err.message)));
          },
        },
      }).catch((err: Error) => finish(() => reject(failure("herdr_unavailable", err.message))));
    });
  return Object.assign(call, { subscribe: herdrSubscribe(socketPath) });
}
