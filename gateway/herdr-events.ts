// Herdr event subscriptions: events.subscribe keeps its connection open. The first
// line is the acknowledgement, every later line one pushed event. Nothing is replayed
// from before the acknowledgement.

import { GatewayError, type HerdrCall } from "./config.ts";

export interface Subscription {
  // The next event, or null when none arrives within timeoutMs. Rejects once the
  // connection is gone (Herdr restarting) and no event is left.
  next(timeoutMs: number): Promise<any | null>;
  close(): void;
}

export type Subscribe = (subscriptions: Array<Record<string, unknown>>, ackTimeoutMs?: number) => Promise<Subscription>;

// herdrSocket's call carries subscribe; a HerdrCall without one (a test fake, an
// older wrapper) cannot wait for events, and callers poll instead.
export function subscriberOf(herdr: HerdrCall): Subscribe | undefined {
  const s = (herdr as HerdrCall & { subscribe?: Subscribe }).subscribe;
  return typeof s === "function" ? s : undefined;
}

let seq = 0;

export function herdrSubscribe(socketPath: string): Subscribe {
  return (subscriptions, ackTimeoutMs = 5000) =>
    new Promise((resolveAck, rejectAck) => {
      const id = `gw:${process.pid}:sub:${++seq}`;
      const events: any[] = [];
      let pending: Buffer[] = [];
      let acked = false;
      let closed: GatewayError | null = null;
      let waiter: (() => void) | null = null;
      let sock: { end(): void; write(d: string): number } | undefined;
      const wake = () => {
        const w = waiter;
        waiter = null;
        w?.();
      };
      const fail = (err: GatewayError) => {
        if (closed) return;
        closed = err;
        clearTimeout(timer);
        if (!acked) rejectAck(err);
        wake();
      };
      const timer = setTimeout(() => {
        fail(new GatewayError("herdr_timeout", `herdr events.subscribe was not acknowledged within ${ackTimeoutMs}ms`));
        sock?.end();
      }, ackTimeoutMs);

      const sub: Subscription = {
        next(timeoutMs) {
          if (events.length) return Promise.resolve(events.shift());
          if (closed) return Promise.reject(closed);
          return new Promise((res, rej) => {
            const t = setTimeout(() => {
              waiter = null;
              res(null);
            }, Math.max(0, timeoutMs));
            waiter = () => {
              clearTimeout(t);
              if (events.length) res(events.shift());
              else rej(closed);
            };
          });
        },
        close() {
          fail(new GatewayError("herdr_closed", "subscription closed"));
          sock?.end();
        },
      };

      // One complete line: the acknowledgement first, then events.
      const line = (bytes: Buffer) => {
        let msg: any;
        try {
          msg = JSON.parse(bytes.toString("utf8"));
        } catch {
          return fail(new GatewayError("herdr_bad_response", "herdr returned invalid JSON"));
        }
        if (!acked) {
          if (msg.error) return fail(new GatewayError(msg.error.code ?? "herdr_error", msg.error.message ?? "herdr error"));
          acked = true;
          clearTimeout(timer);
          return resolveAck(sub);
        }
        events.push(msg);
        wake();
      };

      Bun.connect({
        unix: socketPath,
        socket: {
          open(s) {
            sock = s;
            if (closed) return void s.end();
            s.write(JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } }) + "\n");
          },
          data(s, chunk) {
            // Split on bytes, not strings: a multi-byte character can straddle two chunks,
            // and a line can arrive in pieces.
            pending.push(chunk);
            if (!chunk.includes(0x0a)) return;
            let bytes = Buffer.concat(pending);
            let nl: number;
            while ((nl = bytes.indexOf(0x0a)) >= 0 && !closed) {
              const one = bytes.subarray(0, nl);
              bytes = bytes.subarray(nl + 1);
              if (one.length) line(one);
            }
            pending = bytes.length ? [bytes] : [];
            if (closed) s.end();
          },
          close() {
            fail(new GatewayError("herdr_closed", "herdr closed the event subscription"));
          },
          error(_s, err) {
            fail(new GatewayError("herdr_unavailable", err.message));
          },
        },
      }).catch((err: Error) => fail(new GatewayError("herdr_unavailable", err.message)));
    });
}
