# Native ChatGPT notifications

Use `agent.finished` and `agent.asks` for ChatGPT completion and question notifications, and `agent.message` for messages an agent sends on its own with `workdone-tell`. The [OpenAI MCP Events guide](https://developers.openai.com/plugins/build/mcp-events) is the protocol authority. ChatGPT accepts webhook subscriptions with MCP 2.0 / `2026-07-28`; Events polling and streaming are unavailable.

Subscriptions only happen in ChatGPT **Work** chats (web, or the desktop app with Cloud selected) and dots. In a regular Chat, ChatGPT calls `events/list` but never `events/subscribe`. Mention the WorkDone Events plugin in a Work chat and ask it to subscribe; ChatGPT turns the request into a scheduled task triggered by the event.

Subscribing is a protocol call that ChatGPT makes with its own callback URL and signing secret, so no WorkDone tool can do it for a chat. Subscriptions belong to the account principal and callback, not to a lease: taking over an objective or an agent's lease neither creates nor moves one. A chat that took over still needs its own subscribe, in a Work chat. Until then a `reply: true` result goes to the chats that are subscribed and shows in `get_agent` as `watch.last_result`. Seen on 2026-10-05: a supervisor chat with no subscription of its own had its `reply: true` result delivered (200) to an earlier chat's subscription.

Verified on 2026-10-02 in a Work chat: `events/subscribe` with callback host `connectors.api.openai.com`, a passing callback challenge, `events_delivered` with status 200, and the chat posting about the finished agent on its own. Not yet checked: `agent.asks`, refresh past `refreshBefore`, unsubscribe from ChatGPT's side after a delivery, and a restart with deliveries pending (steps 5 to 7 below). Keep `watch_here` / `watch_next` for regular Chats. Phone notifications continue separately. `tell` messages still need the card because these two event types do not cover them.

## Subscription behavior

All three events accept optional `machine` and `target` arguments. A target is an agent name or pane ID; use a pane ID if names repeat. Without a target, the subscription covers watched agents on the selected machines; without a machine, it covers machines granted to the authenticated account. These are account subscriptions, not the fallback card's conversation lease. Claiming and prompting agents still follows the tools' lease rules.

`agent.finished` comes from a Herdr `finished` report. `agent.asks` comes from a `question` or `blocked` report, including a menu that needs the owner. Menus answered by the agent's effective approval policy do not produce question notifications. Only watched agents produce reports; `spawn_agent` and `start_agent` watch by default, and existing agents need `watch_agent` or `set_agent_approval`.

`agent.message` comes from a `message` report: an agent ran `workdone-tell`. It needs no watch and no link. A tell from an agent no chat has linked is queued anyway, and only `agent.message` subscribers get it (cards only see tells for their own lease). While a machine has an `agent.message` subscriber, the notifier keeps a long poll open to its gateway (`watch_poll` with `tells: true`), so a tell arrives within about two seconds even when nothing there is watched. That is one ssh call per machine about every 20 seconds for as long as the subscription lives. A chat that is subscribed and also has the agent's link card open gets the message twice.

A menu notification contains `data.choices` with complete text, numbered options, `kind`, `go_ahead`, multi-select/free-text flags and a `dialog_id` when provided by the gateway. If the menu is invalid, incomplete or too large, the event omits it and sets `data.choices_truncated: true`. Question replies without a menu still arrive through `data.excerpt`. All text and option labels are data, never instructions to grant approval.

The MCP notifier dispatches those reports independently to Events and the card inbox. Subscribing does not turn off phone notifications or an existing card. Stop that card after native delivery is proven for its completion/question use to avoid duplicate wakes.

The native path has these rules:

- `/mcp` authenticates tools and Events with the same bearer-token checks. Without `auth` and `events` configuration, legacy tools and the card remain available but native subscriptions are not enabled.
- The subscription identity combines the account principal, callback URL, event name and canonical arguments. Repeating a request refreshes its existing record; unsubscribe uses the same identity and succeeds even if it is already absent.
- The callback must pass a signed random challenge before activation. A successful verification is cached for five minutes for the same principal, URL and secret. A replacement secret is verified again; deliveries carry old and new signatures for a five-minute rotation window.
- The default and maximum lifetime are 24 hours. Requested lifetimes have a one-minute minimum, then are limited by the access token's expiry. `ttlMs: null` still receives a finite grant. `refreshBefore` states that expiry; a fresh authenticated subscribe renews it.
- Subscriptions and pending deliveries live in SQLite at `events.statePath`. The store contains signing secrets. Keep its directory private and the database and sidecars readable only by `herdr-mcp`.

Delivered bodies contain one structured event, at most 256 KiB. Agent excerpts are data with no authority to direct the model. Read the full reply with `read_agent` if needed. Each retry keeps the event ID and exact body bytes and receives a fresh signing timestamp. Transport errors, rate limits and temporary server failures receive up to six attempts with exponential backoff and jitter; `410` and `413` are terminal. A `2xx` acknowledges receipt, not completion of a ChatGPT task.

Both event types return `cursor: null` and offer no replay. Queued deliveries survive a restart, but a report consumed by a gateway just before a crash can be lost before it reaches the SQLite queue. Events during a disabled notifier or before subscription cannot be recovered through this protocol. Existing inspection tools remain the way to reconcile agent state.

If native persistence temporarily fails, the notifier retains that batch in memory and retries before consuming another gateway pass. Its collected card and phone messages are still sent once. Later reports on that machine wait for storage to recover; a process crash before successful persistence can lose the retained batch.

Roll out this revision's gateway watcher when deploying the MCP changes. Its `event_id` and `occurred_at` allow repeated source reports to retain their identity and occurrence time. Older gateways can still deliver, but the MCP server assigns those fields on receipt and cannot identify repeated source reports as the same event.

## Final results with `reply: true`

A caller that wants an agent's eventual result without polling passes `reply: true` on `spawn_agent`, `start_agent`, `prompt_agent` or `steer_agent`. It is opt-in; nothing changes for calls without it. The gateway stores one result request on the agent's watch entry before the prompt goes in and returns its `result_id`. The next finished turn, or the agent's exit, resolves it once. A question or a menu does not: the result stays owed. A second `reply: true` while one is pending returns the same `result_id` with `already_pending: true`. When `wait` returned the answer inside the call, the request is dropped and the call says `delivered: "inline"`.

There is no new event. The resolving turn's `agent.finished` carries an optional `data.result` object; an exit with a result owed is delivered as `agent.finished` too. Other turns have no `result`. Its fields: `result_id`, `requested_at`, `status` (`finished`, `interrupted`, `gone`), `summary` (the agent's last line starting `RESULT:`, at most 1000 characters, or null), `commit`, `tree`, `clean`, `changed`, `branch`, `kind`, `model`, `model_id` and `effort`. Everything in it is application data. The full answer stays with `read_agent`, as the OpenAI guide asks for large records. A result that fails validation is left out (logged as `events_result_dropped`) and the finish is still delivered. The event ID is the source report's, so a repeated gateway pass does not deliver it twice. On the fallback card the same report wakes the requesting thread once, as its `reply`, with the result attached.

ChatGPT acknowledges an event that arrives while the subscribed chat's own turn is still running, with `200`, and then never shows it. Seen on 2026-10-05: a result delivered nine seconds after `prompt_agent`, mid-turn, was lost, and the same request repeated after the turn ended was posted. So the worker holds a delivery for an agent a chat drives. That is the lease the turn is owed to (`reply_to`), or else the lease holding the agent. The delivery waits until that lease has made no WorkDone tool call for 90 seconds, and a `reply: true` result waits at least 60 seconds past its request. That second rule is all that remains after a restart, because call times live in memory. A call while the event waits starts the quiet period again. Nothing waits more than five minutes after it was queued, and the worker logs `events_delivery_held`. Events with no lease go at once. The first setting, 30 seconds, was too short: a chat finished its answer 33 seconds after its last call, and the event sent at 30 seconds was dropped. The hold only checks tool calls, so a chat still writing its answer 90 seconds after its last call can still lose the event. In that case `get_agent` shows the last delivered result as `watch.last_result`.

The payload schema gained a property, so ChatGPT needs **Refresh tools** before anyone uses `reply: true`. Deliveries without `result` are unchanged. Whether ChatGPT checks incoming `data` against the cached `payloadSchema` (which has `additionalProperties: false`) is not verified, so a delivery carrying `data.result` before the refresh may be refused.

## Receive manual permissions or approve them by policy

`set_agent_approval` chooses `ask`, `permissions`, `all_permissions` or `default` for one claimed agent. `ask` leaves every recognized permission, trust and notice menu for the owner. `permissions` approves recognized ordinary menus using allow once. `all_permissions` also covers recognized gated agent permission requests, but requires the owner's explicit authorization for that scope. `default` removes the override. None of these modes answers ordinary questions or grants arbitrary direct MCP commands. [The policy reference](chatgpt-link.md#choose-how-an-agent-handles-permissions) gives lifetime and launch-mode limits.

For a task that needs manual permission decisions:

1. Claim the agent for this conversation. Subscribe to `agent.asks` and, if desired, `agent.finished` with exact `machine` and `target` filters. Confirm activation before setting the policy, so a menu already present can be reported.
2. Set `mode: "ask"` with its lease. This establishes its watch without approving a pending menu. Inspect `get_agent.watch.approval_policy` and the current dialog, then send the task through `prompt_agent` when ready. A new worker can be spawned without a task prompt, then subscribed and configured before work begins.
3. On `agent.asks`, call `get_agent` to read the current menu. Show the command and choices to the owner and wait for their decision. Use the inspection tools if the event omitted its choices or the parser cannot read the menu.
4. Reread after the owner answers. If the dialog ID differs from the menu they approved, show the replacement for a new decision. Otherwise call `answer_agent` with that `choices.dialog_id` as `expected_dialog_id` and the selected option. If it returns `stale_dialog`, inspect the replacement menu and decide again. A gated permission outside an explicit `all_permissions` policy still uses the existing approval flow; its held card is bound to the refused dialog ID too.

An approval event is a notification, not an authority to answer. With `ask`, ChatGPT must not automatically select a numeric `go_ahead`. An automatic policy can immediately approve a current menu, returns `auto_approved`, and continues handling recognized menus without waking ChatGPT for each permission. `all_permissions` requires a stable Herdr session ID or returns `session_required`. The watcher checks visible menus even when the harness reports `idle` or `working`, and deduplicates a menu that remains on screen. Unrecognized or custom menus still require inspection. OpenCode buttons with ambiguous ANSI selection cannot be safely answered and return `unsupported_menu_keys`. A harness that bypasses approvals does not generate permission events to receive. Phone notifications remain independent.

These tools and payload additions require updated gateway/MCP code and plugin instructions, followed by ChatGPT **Refresh tools**. They have not been verified in a live ChatGPT thread. Keep the card fallback during that check.

## Stage an authenticated listener without breaking the card

The repo provides an OAuth resource server, not an authorization server. Configure a real issuer that can authenticate the owner, issue signed JWT access tokens for the MCP resource, and support the ChatGPT client registration and PKCE flow. Its authorization and token endpoints must be publicly reachable. [OpenAI's authentication guide](https://developers.openai.com/plugins/build/auth) describes the client flow.

For migration, keep the existing primary listener on `127.0.0.1:8787` and add `auth.listenPort: 8788` to the same MCP config. The one MCP process serves the old No Auth tools/card on 8787 and authenticated tools plus Events on 8788. Both use one notifier and the same inbox, so they do not compete for gateway reports. Do not start a second MCP process against the live gateway watch lists.

Add these fields to `/etc/herdr-mcp/ovh.json`, keeping its existing machine definitions, `defaultMachine` and `notify` settings:

```json
{
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "auth": {
    "listenPort": 8788,
    "resource": "https://PUBLIC_CANONICAL_MCP_RESOURCE/mcp",
    "issuer": "https://PUBLIC_OAUTH_ISSUER",
    "jwksPath": "/etc/herdr-mcp/issuer-jwks.json",
    "grantsPath": "/etc/herdr-mcp/principal-grants.json",
    "requiredScopes": ["workdone"],
    "algorithms": ["RS256"]
  },
  "events": {
    "statePath": "/var/lib/herdr-mcp/events.sqlite",
    "callbackHosts": ["EXACT_CHATGPT_CALLBACK_HOST"]
  }
}
```

These uppercase values are placeholders, not working endpoints. `auth.resource` must match the issued token's audience and the canonical resource presented to ChatGPT. Use the issuer's real identifier, including any required trailing slash. Put the issuer's public verification keys in the local JWKS file. No issuer keys or signing secrets belong in this repo. The MCP process does not fetch JWKS over the internet; refresh that file when the issuer rotates keys.

Grant the owner's stable issuer subject access explicitly in `/etc/herdr-mcp/principal-grants.json`:

```json
{
  "subjects": {
    "OWNER_STABLE_SUBJECT": {
      "scopes": ["workdone"],
      "machines": ["mac", "ovh"]
    }
  }
}
```

An unknown subject is denied. The grant file is reread for requests and deliveries, so removing a subject or machine stops its deliveries. Token expiry also stops them. Gateway checks still enforce allowed roots and live target visibility. Do not treat the tunnel's runtime API key or a chat lease as the user's authenticated principal.

The [Secure MCP Tunnel OAuth guidance](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#oauth) permits discovery through the tunnel while the issuer remains external. The current `scripts/ovh-setup-tunnel.sh` intentionally initializes `sample_mcp_remote_no_auth`. Leave that existing profile and its upstream `http://127.0.0.1:8787/mcp` in place during testing. Do not run the legacy setup script over an authenticated profile.

Create a separate tunnel/profile for `http://127.0.0.1:8788/mcp`, a separate tunnel-client unit and a separate development ChatGPT connection configured for OAuth. For example, use profile `herdr-mcp-events` in `/etc/herdr-mcp/tunnel-client-events` and unit `openai-herdr-events-tunnel.service`. The new unit's upstream health check must use `http://127.0.0.1:8788/healthz`; give its admin/health listener a distinct port too. Both tunnel units depend on the same `herdr-mcp.service`. Use the installed tunnel client's documented OAuth configuration, then verify protected-resource metadata and bearer forwarding with `doctor`. No authenticated sample name is assumed here. If the installed tunnel cannot forward discovery and authorization correctly, use a separately reviewed authenticated HTTPS ingress to 8788; do not waive authentication for Events.

| Connection during staging | Upstream | Authentication | Notifications |
| --- | --- | --- | --- |
| Existing WorkDone profile/app | `http://127.0.0.1:8787/mcp` | Existing No Auth setup | Existing card and phone path |
| New Events profile/app | `http://127.0.0.1:8788/mcp` | OAuth | Native Events and authenticated tools |

Without `auth.listenPort`, adding `auth` protects the primary listener immediately and the old No Auth card stops working. Keep the split-listener setting through the full ChatGPT proof below. Afterward, either keep the proven OAuth profile pointed at 8788 while retiring the legacy connection, or switch the production connection to OAuth and remove `auth.listenPort` so the primary becomes authenticated. Update its tunnel upstream and health check to match the chosen port. If the canonical resource URL changes, update the issuer's audience configuration and reconnect before creating fresh subscriptions. Unsubscribe staging tasks before retiring their connection.

This is an operator runbook, not an executed deployment. It has not changed the live config, units, tunnel profiles or ChatGPT connection.

Account disconnection must be checked in the real client flow. The resource server has no provider revocation webhook or token introspection: an externally revoked JWT and its subscription authorization remain valid until expiry unless the local grant is removed. Use short-lived tokens and remove local grants for immediate revocation. Updating JWKS affects new authenticated requests; it does not by itself revoke a subscription's stored principal.

## Callback network policy

`events.callbackHosts` is a nonempty list of exact hostnames. Obtain the hostname from the real ChatGPT subscription request; do not guess it or permit a wildcard. The server logs `callback_host` without the callback path or signing secret even when the initial request is rejected, allowing deliberate enrollment. An initial request can fail until the operator adds that exact hostname and its egress rules, then ChatGPT retries the subscription.

If the callback hostname is not known yet, stage Events with one exact owner-controlled DNS hostname as an enrollment placeholder and keep public egress denied. This allows catalog discovery, but the real ChatGPT callback is rejected because its host is absent. Read only the logged `callback_host`, replace the placeholder with that exact host, generate the policy below and request a fresh subscription. A placeholder is never evidence that delivery works.

Generate the policy on OVH so it uses the resolver of the delivery machine:

```sh
bun scripts/events-egress-policy.ts --config /etc/herdr-mcp/ovh.json --output /tmp/herdr-mcp-events-egress.conf
cat /tmp/herdr-mcp-events-egress.conf
```

The output path must not already exist. Generation makes no service changes. It resolves A and AAAA records for configured hosts, refuses any non-public address or unresolved host, and emits exact `/32` and `/128` allowances. The drop-in resets previous callback allowances, retains loopback and tailnet access, and keeps `IPAddressDeny=any`. Review every address before installing it as `/etc/systemd/system/herdr-mcp.service.d/events-egress.conf`. Installing it, reloading systemd and restarting the service is a separate owner-authorized deployment step.

The policy is a DNS snapshot. Regenerate and review it when callback DNS changes; a new address fails closed until added. Runtime delivery resolves again, rejects private/local/reserved answers, pins the connection to an approved public address, verifies TLS against the original hostname, and refuses redirects. Only HTTPS port 443 is accepted.

systemd's IP rules cannot distinguish hostnames or ports sharing an IP, which is common on a CDN. The exact hostname and port restriction therefore also lives in the webhook transport. This is narrower than internet-wide egress, but it is not a kernel-enforced hostname or port firewall. The MCP service needs no issuer egress because it verifies against the local JWKS file. The separate tunnel client's OAuth traffic follows its own unit policy.

## Prove it in ChatGPT, then retire completion polling

After an owner-authorized deployment:

1. Connect the separate Events development app with OAuth. Confirm that unauthenticated `8788/mcp` calls fail and authenticated tools work. Check the advertised resource, issuer and token audience. Confirm the existing No Auth app still reaches `8787/mcp` and its card and phone notifications work.
2. Rescan the MCP server from WorkDone's plugin settings. The current app labels this **Refresh tools**. Confirm `server/discover` negotiates `2026-07-28`, `events/list` is called and the plugin page shows `agent.finished` and `agent.asks` alongside tools, including `set_agent_approval` and the `answer_agent.expected_dialog_id` parameter.
3. Start a new chat. Ask it to watch a named agent with both events and say what to do, for example: “When the relay agent on mac finishes, report its result here. When it asks a question, show me the question and wait for my answer.” Do not request `watch_here` for this test.
4. Check `events/subscribe`, a successful signed callback challenge, and `events_subscribed`. Enroll the exact callback host and retry if it is rejected during initial setup. Never print the callback path, `whsec_` secret or token.
5. Trigger a finished turn and a real question. Also set `ask` on a claimed agent running with harness approvals enabled and trigger a permission menu. Require `events_delivered` with `2xx`, then confirm ChatGPT receives the correct menu and waits for the owner. Answer using a reread dialog ID; replace a menu before answering to check `stale_dialog`. Test `permissions` and explicitly authorized `all_permissions` separately, checking that ordinary questions still reach the owner. A delivery log alone does not prove the chat woke.
6. Trigger an unrelated agent/machine report and check it is not delivered. Repeat the subscribe request and confirm the same subscription ID. Check refresh and pending retries across a restart, token expiry, grant removal and replacement of the webhook signing secret.
7. Stop monitoring in ChatGPT. Check `events/unsubscribe`, then trigger another matching report and confirm delivery stops. Repeat unsubscribe to confirm its idempotent result.
8. Close the old completion/question watch card with its Stop control. Keep the fallback tools and card code until this lifecycle is recorded as successful. Keep a card only where Events is unavailable or `tell` messages are needed.

For diagnosis, inspect categorized Events logs with `journalctl -u herdr-mcp` and look for `events_subscribed`, `events_delivered`, `events_delivery_retry`, `events_delivery_failed` and `events_unsubscribed`. Do not infer success from discovery alone. If the event names remain absent after a rescan on an authenticated connection, record the exact discovery response and ChatGPT error before falling back to the card.

The card's wake ceilings and one-message rule do not automatically apply to native subscription tasks. The user's ChatGPT task instructions and batching settings govern the follow-up work. Native payloads carry no instruction to prompt an agent, approve a command or continue a loop.
