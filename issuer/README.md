# WorkDone issuer

A small OAuth authorization server for one owner, so ChatGPT can sign in to the MCP server on port 8788 and subscribe to native Events. It is [`oidc-provider`](https://github.com/panva/node-oidc-provider) plus two forms (password, then approve). The MCP server stays a resource server that only reads tokens; see [docs/mcp-events.md](../docs/mcp-events.md).

It has been built and tested, not deployed. The tests run the whole sign-in against a real local issuer and verify the token the way `mcp/src/auth.ts` does.

## What it does and does not do

- ChatGPT identifies itself with a client ID metadata document (its `client_id` is an HTTPS URL). Only `chatgpt.com` and `openai.com` hosts may be fetched, and every redirect URI in the document must be on those hosts too. There is no registration endpoint.
- PKCE with S256 is required. Tokens are RS256 JWTs: `aud` is the MCP resource, `scope` is `workdone`, `sub` is the owner, one hour of life. Refresh tokens last 30 days and rotate.
- Login is one password, scrypt-hashed, five wrong tries per address per 15 minutes. There is no passkey, no second factor and no account recovery. Whoever has the password can run commands on your machines through ChatGPT, so make it long.
- `oidc-provider`'s dynamic registration and introspection are off. If ChatGPT turns out not to send a client metadata document, registration would have to be turned on with a redirect allowlist. That is not built.

## Set up on OVH

1. **A hostname.** Point a DNS name (say `auth.example.com`) at OVH and open ports 80 and 443. Install Caddy and use `deploy/Caddyfile.issuer` with that name.
2. **Keys and password.** As the `workdone-issuer` user, with the password on stdin so it never lands in a shell history:

   ```sh
   read -rs PW && printf '%s\n' "$PW" | bun src/setup.ts /var/lib/workdone-issuer; unset PW
   ```

   This writes `signing-key.json`, `cookie-keys.json` and `password-hash` (all mode 600) and a public `jwks.json`. It refuses to replace an existing signing key. `--rotate-password` changes only the password.
3. **Environment**, in `/etc/workdone-issuer/env`:

   ```
   ISSUER_URL=https://auth.example.com
   MCP_RESOURCE=https://PUBLIC_CANONICAL_MCP_RESOURCE/mcp
   OWNER_SUBJECT=owner
   ```

   `ISSUER_URL` must be exactly `auth.issuer` in the MCP config, and `MCP_RESOURCE` exactly `auth.resource`. A mismatch shows up as `invalid_token` on every call.
4. **The MCP side.** Copy `jwks.json` to `/etc/herdr-mcp/issuer-jwks.json`. In `principal-grants.json` the subject is `owner` (or whatever `OWNER_SUBJECT` is). The `auth` block in the runbook then takes `issuer` = `ISSUER_URL` and `algorithms: ["RS256"]`.
5. **The service.** `deploy/systemd/workdone-issuer.service`, then `systemctl enable --now workdone-issuer`. Check `curl https://auth.example.com/.well-known/openid-configuration` for `"code_challenge_methods_supported":["S256"]` and `"client_id_metadata_document_supported":true`.

Then carry on with the runbook from "Connect the separate Events development app with OAuth".

## Things to know

- **Node, not Bun, in production.** `oidc-provider` warns on Bun. The unit runs `node src/server.ts` (Node 24 strips types itself, so there is no build). The tests and `setup.ts` use Bun. Storage is `node:sqlite`, which both have.
- **The audience is one URL.** If the public resource URL changes, change `MCP_RESOURCE`, the MCP config and the ChatGPT connection together, and reconnect.
- **Key rotation is manual.** The MCP reads the JWKS from a file. To rotate, put the new public key in the JWKS next to the old one, switch the signing key, and drop the old one after an hour.
- **Revoking.** Deleting the subject from `principal-grants.json` stops access at once. Deleting `oidc.sqlite` forgets every authorization, and ChatGPT has to sign in again.
- **Not tested against real ChatGPT.** The client ID metadata path in particular only ran against a statically configured client. The first real connection is the test, and its failures will show in the issuer's journal.

## Tests

```sh
cd issuer && bun test && bunx tsc --noEmit
```
