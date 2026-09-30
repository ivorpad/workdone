import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { type ClientRequest, type IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

export const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 10_000;

export type CallbackReason = "invalid_url" | "forbidden_address" | "dns_error" | "timeout" | "network_error" | "redirect" | "response_too_large" | "payload_too_large" | "invalid_secret" | "challenge_failed";

export class CallbackError extends Error {
  constructor(public readonly reason: CallbackReason) {
    super(`Webhook callback failed: ${reason}`);
    this.name = "CallbackError";
  }
}

// Reject special-use space conservatively. Mapped IPv4, transition mechanisms,
// multicast, and IPv6 addresses outside global unicast are never destinations.
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family !== 6 || address.includes("%")) return false;
  const [first, second = "0"] = address.toLowerCase().split(":");
  const a = parseInt(first || "0", 16);
  const b = parseInt(second || "0", 16);
  if (a < 0x2000 || a > 0x3fff) return false;
  if (a === 0x2001 && (b < 0x0200 || b === 0x0db8)) return false;
  if (a === 0x2002) return false;
  if (a === 0x3fff && b < 0x1000) return false;
  return true;
}

function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function validHost(host: string): boolean {
  if (isIP(host)) return isPublicAddress(host);
  if (host.length > 253 || !host.includes(".") || host.endsWith(".")) return false;
  if (/(?:^|\.)(?:localhost|local|localdomain|internal|home|lan|invalid|test|example|onion)$/.test(host) || /(?:^|\.)home\.arpa$/.test(host)) return false;
  return host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

// Configuration entries are exact hosts. Wildcards, URL strings, and ports are
// rejected so a configuration typo cannot silently broaden callback access.
export function validateCallbackHosts(hosts: readonly string[]): string[] {
  return [...new Set(hosts.map((host) => {
    if (typeof host !== "string" || host !== host.trim() || /[\s/@?#\\]/.test(host)) throw new CallbackError("invalid_url");
    const normalized = unbracket(host.toLowerCase());
    if (!validHost(normalized)) throw new CallbackError("invalid_url");
    return normalized;
  }))];
}

export function validateCallbackUrl(value: string, allowedHosts?: readonly string[]): URL {
  if (typeof value !== "string" || /[\s\\#]/.test(value) || value.length > 4096 || !/^https:\/\//i.test(value) || /^https:\/\/[^/?#]*@/i.test(value)) throw new CallbackError("invalid_url");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CallbackError("invalid_url");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) throw new CallbackError("invalid_url");
  const host = unbracket(url.hostname.toLowerCase());
  if (!validHost(host)) throw new CallbackError(isIP(host) ? "forbidden_address" : "invalid_url");
  if (allowedHosts && !validateCallbackHosts(allowedHosts).includes(host)) throw new CallbackError("forbidden_address");
  return url;
}

export function parseSigningSecret(secret: string): Buffer {
  if (typeof secret !== "string" || secret.length < 38 || secret.length > 94 || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new CallbackError("invalid_secret");
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, "base64");
  if (key.length < 24 || key.length > 64 || key.toString("base64") !== encoded) throw new CallbackError("invalid_secret");
  return key;
}

export function signHeaders(subscriptionId: string, webhookId: string, body: string, secrets: readonly string[], now: number | Date = Date.now()): Record<string, string> {
  if (typeof subscriptionId !== "string" || typeof webhookId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(subscriptionId) || !/^[A-Za-z0-9._:-]{1,256}$/.test(webhookId)) throw new Error("Invalid webhook identifier");
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BYTES) throw new CallbackError("payload_too_large");
  if (!secrets.length) throw new CallbackError("invalid_secret");
  const milliseconds = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Invalid webhook signing time");
  const timestamp = String(Math.floor(milliseconds / 1000));
  const signed = `${webhookId}.${timestamp}.${body}`;
  const signatures = [...new Set(secrets)].map((secret) => `v1,${createHmac("sha256", parseSigningSecret(secret)).update(signed, "utf8").digest("base64")}`);
  return {
    "Content-Type": "application/json",
    "webhook-id": webhookId,
    "webhook-timestamp": timestamp,
    "webhook-signature": signatures.join(" "),
    "X-MCP-Subscription-Id": subscriptionId,
  };
}

export type ResolvedAddress = { address: string; family: number };
export type WebhookSender = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>;
type RequestFactory = (options: RequestOptions, response: (response: IncomingMessage) => void) => ClientRequest;

export type WebhookSenderOptions = {
  allowedHosts?: readonly string[];
  // Dependency injection for tests; the production defaults use DNS and HTTPS.
  resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  request?: RequestFactory;
  // A shorter timeout is permitted, but callers cannot exceed the 10s cap.
  timeoutMs?: number;
};

export function createWebhookSender(options: WebhookSenderOptions = {}): WebhookSender {
  const allowedHosts = options.allowedHosts === undefined ? undefined : validateCallbackHosts(options.allowedHosts);
  const resolve = options.resolve ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  const request = options.request ?? httpsRequest;
  const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new Error("Webhook timeout must be 1–10000 milliseconds");

  return async (value, headers, body) => {
    const url = validateCallbackUrl(value, allowedHosts);
    if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BYTES) throw new CallbackError("payload_too_large");
    const hostname = unbracket(url.hostname);

    return new Promise((resolveResult, reject) => {
      let done = false;
      let req: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      const finish = (error?: CallbackError, result?: { status: number; body: string }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
          response?.destroy();
          req?.destroy();
        } else {
          resolveResult(result!);
        }
      };
      const timer = setTimeout(() => finish(new CallbackError("timeout")), timeoutMs);

      void (async () => {
        let addresses: readonly ResolvedAddress[];
        try {
          addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname);
        } catch {
          finish(new CallbackError("dns_error"));
          return;
        }
        if (done) return;
        if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)) {
          finish(new CallbackError("forbidden_address"));
          return;
        }
        const destination = addresses[0];
        try {
          req = request({
            protocol: "https:",
            // Connect to the validated literal, never resolve the hostname again.
            hostname: destination.address,
            family: destination.family,
            port: 443,
            method: "POST",
            path: `${url.pathname}${url.search}`,
            servername: isIP(hostname) ? undefined : hostname,
            checkServerIdentity: (_host, certificate) => checkServerIdentity(hostname, certificate),
            rejectUnauthorized: true,
            agent: false,
            headers: { ...headers, Host: url.host, "Content-Length": String(Buffer.byteLength(body, "utf8")) },
          }, (res) => {
            response = res;
            if (done) { res.destroy(); return; }
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              finish(new CallbackError("redirect"));
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            res.on("data", (chunk: Buffer | string) => {
              if (done) return;
              const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              bytes += data.length;
              if (bytes > MAX_RESPONSE_BYTES) { finish(new CallbackError("response_too_large")); return; }
              chunks.push(data);
            });
            res.on("end", () => finish(undefined, { status, body: Buffer.concat(chunks).toString("utf8") }));
            res.on("error", () => finish(new CallbackError("network_error")));
            res.on("aborted", () => finish(new CallbackError("network_error")));
          });
          req.on("error", () => finish(new CallbackError("network_error")));
          req.end(body, "utf8");
        } catch {
          finish(new CallbackError("network_error"));
        }
      })();
    });
  };
}
