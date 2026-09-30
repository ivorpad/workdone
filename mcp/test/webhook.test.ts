import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { CallbackError, MAX_WEBHOOK_BYTES, createWebhookSender, isPublicAddress, parseSigningSecret, signHeaders, validateCallbackHosts, validateCallbackUrl, type CallbackReason } from "../src/webhook.ts";

const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const rotated = `whsec_${Buffer.alloc(24, 11).toString("base64")}`;
const headers = signHeaders("sub_a", "evt_1", "{}", [secret], 1_000);
const publicDns = async () => [{ address: "8.8.8.8", family: 4 }];

type Stub = { status?: number; body?: string; hang?: boolean; fail?: boolean; aborted?: boolean };
function transport(stub: Stub = {}) {
  const calls: { options: RequestOptions; body?: string; destroyed: boolean }[] = [];
  const request = (options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    const call = { options, body: undefined as string | undefined, destroyed: false };
    calls.push(call);
    const req = new EventEmitter() as ClientRequest;
    req.destroy = (() => { call.destroyed = true; return req; }) as ClientRequest["destroy"];
    req.end = ((body: string) => {
      call.body = body;
      queueMicrotask(() => {
        if (call.destroyed || stub.hang) return;
        if (stub.fail) { req.emit("error", new Error("connect failed")); return; }
        const res = new EventEmitter() as IncomingMessage;
        res.statusCode = stub.status ?? 200;
        res.destroy = (() => res) as IncomingMessage["destroy"];
        callback(res);
        if (stub.aborted) { res.emit("aborted"); return; }
        res.emit("data", Buffer.from(stub.body ?? '{"challenge":"ok"}'));
        res.emit("end");
      });
      return req;
    }) as ClientRequest["end"];
    return req;
  };
  return { calls, request };
}

async function rejectsReason(promise: Promise<unknown>, reason: CallbackReason) {
  try {
    await promise;
    throw new Error("Expected callback failure");
  } catch (error) {
    expect(error).toBeInstanceOf(CallbackError);
    expect((error as CallbackError).reason).toBe(reason);
  }
}

describe("public callback destinations", () => {
  test("rejects IPv4 private, local, reserved, documentation and multicast space", () => {
    for (const ip of ["0.0.0.0", "0.8.8.8", "10.0.0.1", "100.64.0.1", "100.127.255.254", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.254", "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.1.1", "198.19.255.254", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.1.2.3", "255.255.255.255", "garbage"]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
    for (const ip of ["1.1.1.1", "8.8.8.8", "100.63.255.254", "100.128.0.1", "172.15.0.1", "172.32.0.1", "192.0.1.1", "198.17.255.254", "198.20.0.1"]) expect(isPublicAddress(ip)).toBe(true);
  });

  test("rejects IPv6 local, mapped, transition, special-use and documentation space", () => {
    for (const ip of ["::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::ffff:7f00:1", "64:ff9b::a00:1", "100::1", "fc00::1", "fd12::1", "fe80::1", "fe80::1%en0", "fec0::1", "ff02::1", "2001::1", "2001:2::1", "2001:20::1", "2001:db8::1", "2002:7f00:1::", "3fff::1"]) expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress("2001:4860:4860::8888")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  test("enforces HTTPS, port 443, no credentials, fragments or local hostnames", () => {
    for (const url of ["http://receiver.example.com/cb", "https://receiver.example.com:8443/cb", "https://user@receiver.example.com/cb", "https://user:pass@receiver.example.com/cb", "https://@receiver.example.com/cb", "https://receiver.example.com/cb#fragment", "https://receiver.example.com/cb#", "https://localhost/cb", "https://service.local/cb", "https://instance.internal/cb", "https://service.test/cb", "https://service.home.arpa/cb", "https://hidden.onion/cb", "https://receiver.example.com./cb", "https://127.0.0.1/cb", "https://2130706433/cb", "https://0x7f000001/cb", "https://[::1]/cb", "https://[::ffff:127.0.0.1]/cb", "https://receiver.example.com\\@127.0.0.1/cb", "https://receiver.example.com/\ncb", "not a URL"]) {
      expect(() => validateCallbackUrl(url)).toThrow(CallbackError);
    }
    expect(validateCallbackUrl("https://RECEIVER.example.com:443/cb?q=1").href).toBe("https://receiver.example.com/cb?q=1");
    expect(validateCallbackUrl("https://[2606:4700:4700::1111]/cb").hostname).toBe("[2606:4700:4700::1111]");
  });

  test("allowlist entries are exact hosts and do not admit wildcard or suffix matches", () => {
    expect(validateCallbackHosts(["RECEIVER.example.com", "receiver.example.com"])).toEqual(["receiver.example.com"]);
    expect(validateCallbackUrl("https://receiver.example.com/cb", ["receiver.example.com"]).host).toBe("receiver.example.com");
    for (const entry of ["*.example.com", "https://receiver.example.com", "receiver.example.com:443", "receiver.example.com.", " receiver.example.com", "localhost", "127.0.0.1"]) expect(() => validateCallbackHosts([entry])).toThrow(CallbackError);
    expect(() => validateCallbackUrl("https://other.receiver.example.com/cb", ["receiver.example.com"])).toThrow(CallbackError);
    expect(() => validateCallbackUrl("https://receiver.example.com/cb", [])).toThrow(CallbackError);
  });
});

describe("Standard Webhooks signatures", () => {
  test("requires canonical base64 keys with 24–64 decoded bytes", () => {
    for (const length of [24, 32, 64]) expect(parseSigningSecret(`whsec_${Buffer.alloc(length).toString("base64")}`).length).toBe(length);
    for (const value of ["", "secret", secret.slice(6), `whsec_${Buffer.alloc(23).toString("base64")}`, `whsec_${Buffer.alloc(65).toString("base64")}`, `${secret}\n`, secret.replace(/=+$/, ""), "whsec_!!!!!!!!", "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="]) expect(() => parseSigningSecret(value)).toThrow(CallbackError);
    // Last base64 character has nonzero unused bits. Buffer accepts it, canonical validation does not.
    const noncanonical = `whsec_${Buffer.alloc(25).toString("base64").replace(/A==$/, "B==")}`;
    expect(() => parseSigningSecret(noncanonical)).toThrow(CallbackError);
  });

  test("signs exact UTF-8 bytes and exposes the required subscription headers", () => {
    const body = '{"eventId":"evt_a","data":{"text":"¿Listo? ☕"}}';
    const signed = signHeaders("sub_a", "evt_a", body, [secret], new Date("2026-10-01T12:05:00Z"));
    const timestamp = String(Date.parse("2026-10-01T12:05:00Z") / 1000);
    const expected = createHmac("sha256", Buffer.alloc(32, 7)).update(`evt_a.${timestamp}.${body}`, "utf8").digest("base64");
    expect(signed).toEqual({ "Content-Type": "application/json", "webhook-id": "evt_a", "webhook-timestamp": timestamp, "webhook-signature": `v1,${expected}`, "X-MCP-Subscription-Id": "sub_a" });
    expect(signHeaders("sub_a", "evt_a", `${body}\n`, [secret], new Date("2026-10-01T12:05:00Z"))["webhook-signature"]).not.toBe(signed["webhook-signature"]);
  });

  test("rotation signs with both keys and each retry receives a fresh timestamp", () => {
    const first = signHeaders("sub_a", "evt_same", "{}", [rotated, secret, secret], 1_000);
    const second = signHeaders("sub_a", "evt_same", "{}", [rotated, secret], 2_000);
    expect(first["webhook-signature"].split(" ")).toHaveLength(2);
    expect(first["webhook-signature"].split(" ")[0]).toBe(signHeaders("sub_a", "evt_same", "{}", [rotated], 1_000)["webhook-signature"]);
    expect(second["webhook-id"]).toBe(first["webhook-id"]);
    expect(second["webhook-signature"]).not.toBe(first["webhook-signature"]);
    expect(second["webhook-timestamp"]).toBe("2");
  });

  test("body cap is bytes, including Unicode, and header values cannot inject new headers", () => {
    expect(() => signHeaders("sub_a", "evt_a", "a".repeat(MAX_WEBHOOK_BYTES), [secret])).not.toThrow();
    expect(() => signHeaders("sub_a", "evt_a", "é".repeat(MAX_WEBHOOK_BYTES / 2 + 1), [secret])).toThrow(CallbackError);
    expect(() => signHeaders("sub_a\r\nx-test: 1", "evt_a", "{}", [secret])).toThrow();
    expect(() => signHeaders("sub_a", "evt_a", "{}", [], 1_000)).toThrow(CallbackError);
  });
});

describe("webhook HTTPS transport", () => {
  test("pins a checked address while preserving hostname, path, body and TLS verification", async () => {
    const fake = transport();
    const sender = createWebhookSender({ resolve: publicDns, request: fake.request });
    const body = '{"text":"héllo"}';
    expect(await sender("https://receiver.example.com/path?key=one", headers, body)).toEqual({ status: 200, body: '{"challenge":"ok"}' });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.body).toBe(body);
    expect(call.options.hostname).toBe("8.8.8.8");
    expect(call.options.servername).toBe("receiver.example.com");
    expect(call.options.path).toBe("/path?key=one");
    expect(call.options.port).toBe(443);
    expect(call.options.method).toBe("POST");
    expect(call.options.rejectUnauthorized).toBe(true);
    expect(call.options.agent).toBe(false);
    expect(call.options.checkServerIdentity).toBeFunction();
    const validCertificate = { subjectaltname: "DNS:receiver.example.com" } as Parameters<NonNullable<RequestOptions["checkServerIdentity"]>>[1];
    const invalidCertificate = { subjectaltname: "DNS:other.example.com" } as Parameters<NonNullable<RequestOptions["checkServerIdentity"]>>[1];
    expect(call.options.checkServerIdentity!("8.8.8.8", validCertificate)).toBeUndefined();
    expect(call.options.checkServerIdentity!("8.8.8.8", invalidCertificate)).toBeInstanceOf(Error);
    expect(call.options.headers).toMatchObject({ Host: "receiver.example.com", "Content-Length": String(Buffer.byteLength(body)), ...headers });
  });

  test("checks every DNS answer and never connects to a mixed public/private result", async () => {
    for (const addresses of [[{ address: "10.0.0.1", family: 4 }], [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }], [{ address: "2001:4860:4860::8888", family: 6 }, { address: "::ffff:10.0.0.1", family: 6 }], [{ address: "8.8.8.8", family: 6 }], []]) {
      const fake = transport();
      const sender = createWebhookSender({ resolve: async () => addresses, request: fake.request });
      await rejectsReason(sender("https://receiver.example.com/cb", headers, "{}"), "forbidden_address");
      expect(fake.calls).toHaveLength(0);
    }
  });

  test("revalidates DNS on every send so rebinding cannot reuse a prior approval", async () => {
    let lookups = 0;
    const fake = transport();
    const sender = createWebhookSender({ request: fake.request, resolve: async () => [{ address: ++lookups === 1 ? "8.8.8.8" : "169.254.169.254", family: 4 }] });
    await sender("https://receiver.example.com/cb", headers, "{}");
    await rejectsReason(sender("https://receiver.example.com/cb", headers, "{}"), "forbidden_address");
    expect(lookups).toBe(2);
    expect(fake.calls).toHaveLength(1);
  });

  test("public literals bypass DNS but are still pinned and verified against the literal", async () => {
    const fake = transport();
    const sender = createWebhookSender({ request: fake.request, resolve: async () => { throw new Error("DNS should not run"); } });
    await sender("https://[2606:4700:4700::1111]/cb", headers, "{}");
    expect(fake.calls[0].options.hostname).toBe("2606:4700:4700::1111");
    expect(fake.calls[0].options.servername).toBeUndefined();
    expect(fake.calls[0].options.headers).toMatchObject({ Host: "[2606:4700:4700::1111]" });
  });

  test("never follows redirects, preserves terminal HTTP statuses and caps responses", async () => {
    const redirect = transport({ status: 302 });
    await rejectsReason(createWebhookSender({ resolve: publicDns, request: redirect.request })("https://receiver.example.com/cb", headers, "{}"), "redirect");
    expect(redirect.calls).toHaveLength(1);
    expect(redirect.calls[0].destroyed).toBe(true);
    for (const status of [410, 413, 429, 503]) {
      const fake = transport({ status, body: "" });
      expect((await createWebhookSender({ resolve: publicDns, request: fake.request })("https://receiver.example.com/cb", headers, "{}")).status).toBe(status);
    }
    const large = transport({ body: "a".repeat(16 * 1024 + 1) });
    await rejectsReason(createWebhookSender({ resolve: publicDns, request: large.request })("https://receiver.example.com/cb", headers, "{}"), "response_too_large");
    expect(large.calls[0].destroyed).toBe(true);
  });

  test("timeout includes DNS and prevents a late DNS result from creating a request", async () => {
    const fake = transport();
    let release!: (addresses: { address: string; family: number }[]) => void;
    const sender = createWebhookSender({ timeoutMs: 5, request: fake.request, resolve: () => new Promise((resolve) => { release = resolve; }) });
    await rejectsReason(sender("https://receiver.example.com/cb", headers, "{}"), "timeout");
    release([{ address: "8.8.8.8", family: 4 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.calls).toHaveLength(0);
  });

  test("connection timeout aborts the request and connection failures are categorized", async () => {
    const hanging = transport({ hang: true });
    await rejectsReason(createWebhookSender({ timeoutMs: 5, resolve: publicDns, request: hanging.request })("https://receiver.example.com/cb", headers, "{}"), "timeout");
    expect(hanging.calls[0].destroyed).toBe(true);
    for (const stub of [{ fail: true }, { aborted: true }]) {
      const fake = transport(stub);
      await rejectsReason(createWebhookSender({ resolve: publicDns, request: fake.request })("https://receiver.example.com/cb", headers, "{}"), "network_error");
    }
    await rejectsReason(createWebhookSender({ resolve: async () => { throw new Error("no DNS"); } })("https://receiver.example.com/cb", headers, "{}"), "dns_error");
  });

  test("rejects oversized bodies and forbidden hosts before DNS or request", async () => {
    let lookups = 0;
    const fake = transport();
    const sender = createWebhookSender({ allowedHosts: ["receiver.example.com"], request: fake.request, resolve: async () => { lookups++; return publicDns(); } });
    await rejectsReason(sender("https://elsewhere.example.com/cb", headers, "{}"), "forbidden_address");
    await rejectsReason(sender("https://receiver.example.com/cb", headers, "é".repeat(MAX_WEBHOOK_BYTES / 2 + 1)), "payload_too_large");
    expect(lookups).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(() => createWebhookSender({ timeoutMs: 10_001 })).toThrow();
  });
});
