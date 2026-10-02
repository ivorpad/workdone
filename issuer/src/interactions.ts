// Login and consent pages. Two forms, no script, no assets. The owner types the password,
// then sees which client is asking for which scope and confirms.

import type { IncomingMessage, ServerResponse } from "node:http";
import type Provider from "oidc-provider";
import type { IssuerConfig } from "./config.ts";
import { checkPassword, Throttle } from "./password.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1rem}input,button{font:inherit;padding:.6rem .8rem;width:100%;box-sizing:border-box;margin:.4rem 0}button{cursor:pointer}.err{color:#c00}code{word-break:break-all}</style></head><body>${body}</body></html>`;

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8192) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", "x-frame-options": "DENY" });
  res.end(html);
}

export function interactionHandler(provider: Provider, cfg: IssuerConfig, throttle = new Throttle(), clientIp = (req: IncomingMessage) => String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0]!.trim()) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://x");
    const m = url.pathname.match(/^\/interaction\/([\w-]+)(?:\/(login|confirm|abort))?$/);
    if (!m) return false;
    const [, uid, action] = m;
    let details;
    try {
      details = await provider.interactionDetails(req, res);
    } catch {
      send(res, 400, page("Expired", "<p>This sign-in expired. Start again from ChatGPT.</p>"));
      return true;
    }
    if (details.uid !== uid) { send(res, 400, page("Expired", "<p>This sign-in expired. Start again from ChatGPT.</p>")); return true; }
    const { prompt, params, session } = details;

    if (req.method === "GET" && !action) {
      if (prompt.name === "login") {
        send(res, 200, page("Sign in", `<h1>Sign in</h1><form method="post" action="/interaction/${esc(uid!)}/login"><input type="password" name="password" autocomplete="current-password" autofocus required placeholder="Password"><button>Continue</button></form>`));
      } else {
        const client = details.params.client_id as string;
        const scope = String(params.scope ?? "").split(" ").filter((s) => s && s !== "openid" && s !== "offline_access").join(", ");
        send(res, 200, page("Approve", `<h1>Approve access</h1><p><code>${esc(client)}</code> wants to use <strong>${esc(scope || cfg.scope)}</strong> on <code>${esc(cfg.resource)}</code>, and to stay connected until you revoke it.</p><form method="post" action="/interaction/${esc(uid!)}/confirm"><button>Approve</button></form><form method="post" action="/interaction/${esc(uid!)}/abort"><button>Deny</button></form>`));
      }
      return true;
    }
    if (req.method !== "POST" || !action) { send(res, 405, page("Not allowed", "<p>Not allowed.</p>")); return true; }

    if (action === "login" && prompt.name === "login") {
      const ip = clientIp(req);
      if (throttle.blocked(ip)) { send(res, 429, page("Try later", "<p>Too many attempts. Try again in a few minutes.</p>")); return true; }
      const form = await readForm(req).catch(() => null);
      const pw = form?.get("password") ?? "";
      if (!pw || pw.length > 512 || !(await checkPassword(pw, cfg.passwordHash))) {
        throttle.fail(ip);
        send(res, 401, page("Sign in", `<h1>Sign in</h1><p class="err">Wrong password.</p><form method="post" action="/interaction/${esc(uid!)}/login"><input type="password" name="password" autocomplete="current-password" autofocus required placeholder="Password"><button>Continue</button></form>`));
        return true;
      }
      throttle.ok(ip);
      await provider.interactionFinished(req, res, { login: { accountId: cfg.subject, remember: false } }, { mergeWithLastSubmission: false });
      return true;
    }

    if (action === "confirm" && prompt.name === "consent") {
      if (!session?.accountId || session.accountId !== cfg.subject) { send(res, 400, page("Expired", "<p>Start again from ChatGPT.</p>")); return true; }
      const grant = details.grantId ? await provider.Grant.find(details.grantId) : new provider.Grant({ accountId: session.accountId, clientId: params.client_id as string });
      if (!grant) { send(res, 400, page("Expired", "<p>Start again from ChatGPT.</p>")); return true; }
      const missing = prompt.details as { missingOIDCScope?: string[]; missingResourceScopes?: Record<string, string[]> };
      if (missing.missingOIDCScope?.length) grant.addOIDCScope(missing.missingOIDCScope.join(" "));
      for (const [resource, scopes] of Object.entries(missing.missingResourceScopes ?? {})) grant.addResourceScope(resource, scopes.join(" "));
      const grantId = await grant.save();
      await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
      return true;
    }

    if (action === "abort") {
      await provider.interactionFinished(req, res, { error: "access_denied", error_description: "The owner denied access." }, { mergeWithLastSubmission: false });
      return true;
    }
    send(res, 400, page("Expired", "<p>Start again from ChatGPT.</p>"));
    return true;
  };
}
