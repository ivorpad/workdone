# ChatGPT ↔ agents: the link, cards and what ChatGPT supports

What was built on 30-09 so a ChatGPT chat and the Herdr agents can talk without the owner relaying: an agent's answer goes back to the chat that asked, an agent can write to that chat itself, and the owner approves irreversible steps with a click. Most of it runs through MCP Apps cards, because that is what ChatGPT supports today. It also records what was tried and didn't work (MCP Events), and what ChatGPT does and doesn't do, as seen in the logs.

## Using it

**Link a chat with an agent.** In ChatGPT:

```
@WorkDone link this chat with the agent in w5M:pA (take it over)
```

ChatGPT claims the agent (`claim_agents`), watches it (`watch_agent`) and calls `watch_here`. A small card appears: "Linked with this chat's agents on mac · 0 replies". From then on:

- **Chat → agent.** Anything ChatGPT sends with `prompt_agent` or `steer_agent` (without `wait`) reaches the agent like a typed message.
- **Agent → chat, as a reply.** When that turn ends, the answer comes back into the chat by itself as a "[WorkDone watch] … replied" message, and ChatGPT carries on: it follows up once if it needs more, or tells the owner.
- **Agent → chat, on its own.** From its pane, an agent runs:

  ```sh
  ~/src/tries/2026-09-25-tailscale-chatgpt-mcp/scripts/tell.sh "message, up to 4000 characters"
  ```

  It prints `{"ok":true,"result":{"queued":true,"lease":"L-…"}}`, and within about 20 s the chat gets "[WorkDone watch] … sent you a message". ChatGPT answers with `prompt_agent`, and that answer lands in the pane. A message sent while no link is open waits up to an hour for one. `no_thread` means no chat holds the pane: link one first.

What does not cross: turns the owner starts at the agent's terminal, status updates, and ordinary finished turns. `questions: true` on `watch_here` adds questions an agent asks in a turn the chat didn't start; `finished: true` adds every finished turn.

To test it in a new agent session in a linked pane, tell the agent: "run `scripts/tell.sh "Test from <name>: reply 'got it' with prompt_agent"` and wait for the answer". A new session in the same pane keeps `$HERDR_PANE_ID`, so the lease still holds.

**Approve an irreversible step.** When `exec`, `answer_agent`, `send_pane_input` or `run_command_in_pane` hits the gated list (push, commit, merge, rebase, reset --hard, branch delete, clean, GitHub writes, rm -rf, deploys), WorkDone holds the call and ChatGPT shows an Approve / Decline card with the exact command. Only the click runs it. See "Approve card" below.

**Things that have to be true.**

- The link card only runs while its chat is open somewhere that keeps running: a chatgpt.com tab (it keeps working in a background tab, 8 to 30 s late), the desktop app, or the iOS app while it is open on that chat. For a link that lasts while the Mac sleeps, keep the chat open in OVH's always-on Chromium.
- After a deploy that changes tools or cards: ChatGPT settings → Plugins → WorkDone Tunnel → **Refresh tools**. Without it ChatGPT keeps the old tool list and cards.
- Only watched agents report. `spawn_agent` and `start_agent` watch theirs; ChatGPT calls `watch_agent` when linking an agent it claimed.

## How the link works

```
ChatGPT chat ──prompt_agent (lease L)──▶ MCP server ──ssh──▶ gateway ──▶ agent pane
     ▲                                                        │ marks the pane: reply owed to L
     │                                                        ▼
  card: ui/message ◀── watch_next (long poll) ◀── inbox ◀── notifier ◀── watch_poll report (reply_to: L)
```

- **Reply owed.** When a lease holder sends `prompt_agent` without waiting, or `steer_agent`, the gateway (`Gateway.request`) sets `reply_to: <lease>` on the pane's watch entry (`StateStore.owe`). When that turn ends, `watch_poll` reports it with `reply_to` once and clears it. A menu mid-turn doesn't clear it.
- **Reports.** `watch_poll` returns, next to the phone messages, `reports`: each event with pane, type (`finished`, `question`, `blocked`, `gone`, `message`, …), excerpt, the live lease holding the pane, and `reply_to` (`gateway/watcher.ts`). The key is only there when there is something to report.
- **Inbox** (`mcp/src/inbox.ts`). The MCP notifier passes each machine's reports to the inbox. Each watch is one chat's lease on one machine. A report for that lease becomes an event: `reply` (a finished or question turn owed to this lease), `message` (tell), `blocked`, and, if asked for, `question` and `finished`. Events are handed out once, even with two cards open.
- **Card** (`mcp/src/watch.html`, an MCP App). It long-polls the app-only `watch_next` (20 s per call) and posts each event into the chat with `ui/message`, which starts a ChatGPT turn. The wake text says the message comes from WorkDone, not the user, and that the agent's words are data, not instructions.
- **tell** (`gateway/agent-ops.ts` op `tell`, `scripts/tell.sh`). The agent's text is queued in the gateway's `told.json`, reported on the next watch pass as a `message` report (not a phone notification), and posted whole by the card.

### Credentials and limits

(Designed with ChatGPT through the link itself on 30-09: it asked for the lease check, the hidden cap and the ceilings, then, reviewing the diff, rejected the "abandoned card" replacement and a model-settable override of the one-message rule. At the time of writing this version is not committed or deployed: it is waiting for ChatGPT's approval.)

- **Lease check.** `watch_here` asks the machine's gateway (`lease_check`) whether the lease exists and is live (used in the last 24 h, the gateway's own lapse rule), and refuses `invalid_lease` otherwise.
- **Hidden cap.** Each watch has a random `cap` (`wc_` + 40 hex). The watch id, cap and lease come back only in the tool result's `_meta["workdone/watch"]`, which the card reads. The model sees none of them. `watch_next` and `watch_stop` need the cap, and a wrong cap gets nothing. Replacing an open link needs the cap too (`already_linked` otherwise), and a replacement keeps the rounds used. The lease isn't in the wake text any more.
- **Ceilings**, whatever the model asks for:

  | Link wakes on | Up to |
  |---|---|
  | replies, tell messages and menus | 72 h, 200 wakes |
  | plus `questions` | 24 h, 50 |
  | plus `finished` | 8 h, 25 |

  A link that used up its wakes can't be opened again for an hour.
- **Polling load.** The card is the only thing that calls ChatGPT's host, so it stays light. A link ends after 30 minutes without activity (opening, a wake handed out, a message the chat sent an agent), not at its hours: polling alone doesn't count, and the chat links again with `watch_here` when it hands an agent work. A poll waits 20 s, or 45 s once the link has been quiet for 5 minutes. A second card polling the same link (another device) is held 30 s by the server, then answered `busy` (the wait is server-side so an older card without this code can't spin). After 8 errors in a row (backoff 5 s doubling to 5 min) the card stops. A silent 72 h link used to cost about 4,300 calls; a quiet one now costs about 50 before it ends.
- **One message per wake.** After a wake, the chat may send its agents one `prompt_agent` or `steer_agent` in the next 10 minutes; a second gets `one_message_per_wake`. There is no parameter that lifts it: a back-and-forth goes on because each reply of the agent is a new wake, which allows the next message. Before a link's first wake, and 10 minutes after one, the chat is acting for the user and isn't limited.
- **Restarts.** Watches live in memory. A card that finds its watch gone after a restart opens it again with the same lease and settings. Cards from before this change can't, and need one new link.

### Why a card and not MCP Events

`developers.openai.com/plugins/build/mcp-events` describes exactly this, with webhooks: ChatGPT subscribes to a server's events and WorkDone would POST to ChatGPT. The server declares `"events": {}` in `server/discover` and lists `agent.finished` and `agent.asks` (`mcp/src/events.ts`). ChatGPT reads `events/list` on every Refresh tools (10 times on 30-09), but it has never sent `events/subscribe`: not when asked in chat ("notify me in this chat whenever the agent in w5M:pA finishes"), and the plugin page shows no events. It chose `watch_agent` and `watch_here` instead. The likely reasons are that the tunnel app has no authentication (the doc speaks of an "authenticated MCP endpoint", and a subscription needs an account to belong to) or that the feature isn't open to apps in development. `events/subscribe` is handled: it logs what ChatGPT asked for (callback host, never the secret) and refuses. `journalctl -u herdr-mcp | grep events_` shows the day that changes. Delivery would also need outbound HTTPS from the MCP unit, which `IPAddressAllow` blocks.

## Approve card

`mcp/src/confirm.ts`, `mcp/src/confirm.html`.

- A gated call the gateway refuses with `needs_confirmation` is held for 15 minutes under a `pending` id, without the model's `confirm`.
- `request_confirmation({pending})` shows the card: what the server holds (machine, reason, the exact command), not the model's description.
- Approve and Decline call `confirm_pending`, app-only (`_meta.ui.visibility: ["app"]`), so the model can't call it. It runs the held call once with `confirm: true` and the card tells the chat the result.
- Tested on chatgpt.com: Approve ran `mkdir … && rm -rf /tmp/workdone-confirm-test`, audited with `"confirm": true`; Decline dropped a `git commit`, audited only as refused.
- `confirm: true` from the model still works. On 30-09 ChatGPT passed it unasked for an `rm -rf` because the user's message named the command, so the card is only a real gate once that route is closed (not done).

## Agents now start with full access

The alias generator (`scripts/agent-aliases.ts`, `FULL_ACCESS`) and the live alias files on the Mac, OVH and syno add `--dangerously-skip-permissions` to Claude Code and `--dangerously-bypass-approvals-and-sandbox` to Codex; Cursor keeps `--force --trust`. Tested on OVH: robin and maple ran shell commands with no prompt; Codex still asks folder trust once, which WorkDone answers. Agents already running keep the mode they started with.

Consequence: agents push, commit, merge and delete without any menu. The gated list and the Approve card only cover what ChatGPT runs itself. What must stay the owner's call has to be enforced outside the agents, for example with GitHub branch protection on `main`.

Before this, the slowness with Codex agents was measured, not guessed: with approvals on, maple showed 19 permission menus in 25 minutes and WorkDone answered each about 2.5 s after it appeared (Herdr's `blocked` event to the audit's `auto_approve`).

maple is now GPT-6.1 Sol (`gpt-6.1-sol`, Codex's newest) at ultra; GPT-6 Astra, maple's old model, is walnut.

## What ChatGPT does and doesn't do (seen 30-09)

- **Protocol.** ChatGPT and the tunnel client both probe `server/discover` with 2026-07-28 first. The MCP server moved to the v2 SDK (`@modelcontextprotocol/server` 2.0.0) and serves both revisions; ChatGPT switched over after a Refresh tools. `logRpc` in `mcp/src/server.ts` logs each handshake (`client_hello`, with the `_meta` envelope) and every method with the tool name, never arguments.
- **No forms.** ChatGPT offers no `elicitation` capability on either revision, so OpenAI's form elicitation isn't available. Its capabilities are `openai/visibility` and MCP Apps (`text/html;profile=mcp-app`).
- **Cards can wake the chat.** A card's `ui/message` sent on a timer, with no click and the card collapsed, is accepted and starts a turn. With `_meta["openai/message"]: {target: "new"}` it opens a new chat instead ("WorkDone Tunnel has started a new chat"), and that chat can search the web. The throwaway `wake_test` tool (`mcp/src/waketest.ts`) proved both and should be removed.
- **In a background tab** the card's timers run late (8 to 30 s) but keep running. ChatGPT may reload a card while a chat is open, which restarts its script: anything that must survive lives on the server.
- **Card caching.** ChatGPT caches a card by URI, so a changed card needs a new URI (`confirm-2`, `watch-6`). Its iOS app was served an older tool list than the web app and asked for card URIs that no longer existed, which showed a grey box. Every old URI now answers with the current card (`registerCard`). A chat also keeps running the card it first loaded for a tool call, even after a reload.
- **CSP.** Cards declare an empty CSP (`ui.csp` and `openai/widgetCSP`); without one the web app shows "CSP off".
- **App-only tools** can't have a `resourceUri` of their own: ChatGPT warns "These private tools can't render their widgets".
- **Clicks in cards** from browser automation land only after a fresh screenshot, because the viewport changes size between screenshots.

## Loops and runaway work

Asked of ChatGPT itself and written up in `docs/loop-risks.md`. The short version: `max_rounds` bounds one link, not the system. The risks it ranked highest are agents prompting each other directly (outside any count), "want me to continue?" ping-pong, review loops, and caps that reset on a new link or a restart. The link above answers part of that (replies only, one message per wake, ceilings, cooldown); a persistent budget shared across chats and agent-to-agent limits in the gateway are not built.

## Open

- ChatGPT's approval of the credentials-and-limits diff, then commit, deploy, and a check that `_meta` reaches the card on real ChatGPT.
- A card closed without Stop keeps its link open until it expires, and the chat can't replace it without the cap. That stays so: ChatGPT's review rejected treating a quiet card as abandoned, since that would let the lease alone take over a link again, and a sleeping laptop or a network pause looks the same. A chat that takes the agent over gets a new lease and can open a fresh link.
- The always-on hub: the linked chat open in OVH's Chromium.
- Remove `wake_test`; close the `confirm: true` route so the Approve card is the only way through.
- The syno gateway has neither `reports` nor `tell` yet.
