# The owner's console

One page for the owner: every agent on every machine, who steers it, what waits on you, what each controller just did. From it you can answer a menu, steer or prompt an agent, take an agent over from a ChatGPT thread, and leave a note for the chat. It is for watching coordination and stopping two controllers from steering the same agent.

It is a client of the gateways and makes the same calls ChatGPT's tools do, as the owner. A call carries `origin: "console"`, which the gateway lets act over every lease while taking none, so a ChatGPT thread that holds an agent keeps it and the console can still steer it. Nothing in the console claims, releases or takes over an agent. Only the console sets that origin: the MCP server drops it from ChatGPT's tool calls, so a thread cannot send it. Source: `mcp/src/console.ts` (handler, refresh, SSE), `console-model.ts` (what counts as "needs you", feed events), `console.html` (the page).

## Turn it on

Add a `console` block to the MCP server config (`config/ovh.example.json`):

```json
"console": { "port": 8790, "ownerLogins": ["you@example.com"] }
```

The listener is loopback only and is not an MCP endpoint, so nothing ChatGPT reaches serves it. Put it on your tailnet with `tailscale serve`, which adds the caller's `Tailscale-User-Login` header; the console answers only logins in `ownerLogins`:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8790
```

`devNoAuth: true` instead of `ownerLogins` answers any loopback request and nothing else. Use it on a laptop, never on a machine that runs agents.

**What this trusts.** A process on the MCP host can send the identity header itself. Agents run on the VPS and already have what that needs (the config, the SSH key to every gateway), so the console adds no new reach, but it is not a boundary against an agent on that box. POSTs also need an `X-WorkDone-Console: 1` header and a same-origin `Origin`, so a web page you visit cannot drive it. The page sends a strict CSP and renders all agent text as text.

## What it shows

A gateway from before this change has no `console_snapshot`, `inbox_resolve`, `lease_list`, `claims`, `audit_tail`, `owner_note`, the `origin: "console"` override or the focus raise. The console still lists its agents from `overview` and says the gateway is legacy; the inbox, claims and some feed lines stay empty and a note fails with `unknown_operation`. Deploy gateways first.

- **Needs you:** menus (with their options), held calls awaiting Approve or Decline, human blockers and acceptance in coordination objectives, agents asking a question, stalled or looping agents (`supervisor_status`), results still owed, machines that don't answer.
- **Agents by objective**, with the ChatGPT thread that holds each, if any (`lease_list`).
- **Objectives:** `coord_snapshot view: "resume"` per machine.
- **Singleton files held:** read from `<repo>/.git/workdone-claims.json` in each configured repo (`claims` op). Nothing in WorkDone writes that file yet, so the panel is empty until a harness does. Shape: `{"claims":[{"path","holder","pane_id"?,"at"?,"note"?}]}`.
- **Who touched what:** gateway reports (finished, question, menu, gone), other controllers' calls from each gateway's audit log (prompts, steers, answers, claims, takeovers, closes), and this console's own actions. A takeover by a thread, and a refusal such as `not_your_agent` or `stale_dialog`, is flagged: that is two controllers colliding.

The page's state is one `console_snapshot` call per machine: agents, supervisor view, coordination objectives, lease holders, file claims, recent audit touches and the inbox. It looks every 4 s while the state is changing, doubles the wait each quiet look up to 60 s, and starts over on a report, a connect or a click. With no page open it does not look at all. Neither `console_snapshot` nor the other console reads (`inbox_list`, `lease_list`, `claims`, `audit_tail`) is written to the gateway's audit log: they are read-only and would otherwise fill it (on 10-06 the old six-call poll made 1,700 of the day's audited calls). Writes, including `inbox_resolve`, are still audited. A gateway from before `console_snapshot` is read the old way, six calls, flagged `legacy` on the page, and asked again every five minutes.

## Inbox

What agents tell the owner is kept by the gateway, not by a chat card or this page, so a finish does not depend on anyone listening. The gateway writes `inbox.json` when:

- an agent calls `workdone-tell` (`tell`);
- the watcher sees a watched agent's turn end (`finished`), its exit (`gone`), or a question (`question`), or the end of a turn someone asked a `reply: true` result of (`result`, with `result_id`, commit, branch).

Each entry keeps the agent's name, pane, session, working directory, its coordination task, and the thread that held it when it spoke (the console sees the thread's label and the last four characters of its lease). It is **unanswered** until the agent is sent a follow-up (`prompt_agent`, `steer_agent` or `supervisor_nudge`, by a thread or the console; the entry records who), its work is settled (`settle_work`), or the owner dismisses it with `inbox_resolve`. `owed_work` shows a chat an agent's unanswered entries while it still owes something: open work, a tell, a question or a result. A result still owed shows as **pending**.

An agent that Herdr marks `done` and that no watch recorded shows as a **derived** entry: read off the live agent each time, not stored, gone when Herdr marks the agent seen. Dismissing it stores a dismissed entry so it does not return. This covers agents nobody watches and turns that ended before a watch existed.

The inbox keeps 500 entries, dropping answered and dismissed ones first and anything older than two weeks; an unanswered entry is never aged out. Unanswered entries are one need per agent under Needs you, with Reply (selects the agent and puts the cursor in the message box), Focus pane and Dismiss all.

**Delivery is stated, never claimed.** Each unanswered entry says where it could go: queued for the thread that holds the agent (its card or Events subscription may or may not be listening), reachable by a chat subscribed to `agent.message` events, or undelivered because no chat has a route. The gateway cannot see whether a card was open or a webhook landed, so "answered" means someone acted on the agent, not that a chat read it. A finished turn nobody follows up on stays unanswered until you dismiss it.

**What it needs.** The watcher records turn ends when something polls the gateway's `watch_poll`: the MCP server's notifier or the standalone `watcher.ts`. A watched agent finishing with neither running is recorded at the next poll, and the derived entries cover the gap in the meantime. An agent the gateway does not watch, and that Herdr never marks `done`, is not in the inbox.

### The beacon and stop-hook idea

The idea was that an agent should only try to wake or deliver to a chat when it has a valid owner or session route, and otherwise leave a durable, visibly undelivered record instead of silently dropping it. The gateway does this centrally, so no per-agent hook is needed:

- The record is written by the watcher and the `tell` op, on the machine, from what Herdr reports. It does not depend on the agent running anything at the end of a turn, so a crash, a killed agent or a CLI with no hook still produces an entry.
- A stop hook runs in the agent's own process and can only call `workdone-tell`, which needs `HERDR_PANE_ID` and a linked chat. It cannot know whether a card is open or a subscription is live, and each CLI (Claude Code, Codex, Cursor) has a different hook mechanism to install and keep working.
- What a hook would add is an agent-written summary at the end. The watcher already reads the agent's last `RESULT:` line from the transcript, and a `reply: true` request carries it.
- The route check lives where the routes are known: a held agent is queued for its thread, an unheld one reaches only an events subscriber, and an agent's `tell` with no route now says in its result that it is kept in the inbox, undelivered. Only the console labels an entry undelivered. ChatGPT and agents never see that label.

So: no stop hook, and no agent-side beacon. The remaining gap is the one under "What it needs": the gateway has to be polled.

## Steering

The page shows which ChatGPT thread holds each agent (`lease_list`: the label and the last four characters of the lease, never the whole id). Steering needs no step first.

1. **Steer** (agent working) or **Send prompt** (idle) calls `steer_agent` / `prompt_agent`. The text ends with a line saying the owner sent it from the console, not from a ChatGPT chat. Disabled only while a menu is up.
2. **Menu buttons** call `answer_agent` with the `dialog_id` of the menu shown, so a menu that moved on is `stale_dialog`, never a wrong answer. A gated menu (push, merge, deploy, `rm -rf`) comes back `needs_confirmation`: it is held and listed under Needs you with Approve and Decline, which run the held call once. The same list shows calls held for ChatGPT's approval card, so you can approve those here.
3. **Send the one nudge** is `supervisor_nudge`, offered when `supervisor_status` recommends it, and the gateway still allows one per agent session.
4. **Focus pane** brings the agent's pane to the front in Herdr on that machine (`focus`, which also marks the agent seen) and, on macOS, raises the terminal app that hosts the Herdr window. The app is `terminalApp` in `gateway.json` (`"Ghostty"` or a path to the `.app`), or found from the process tree above the `herdr` client. A client running over mosh or ssh has no app above it, so set `terminalApp` or the result says why nothing was raised. It changes no steering. On a headless VPS it moves focus nobody is looking at.
5. **Close pane** needs a second click, and the gateway's own limits (`allowCloseAny`) still apply. That click is the owner's go-ahead, so a pane not spawned disposable closes without an approval card. A held `close` from a chat shows in the approval list like any other held call.

If a thread is mid-turn on an agent you steer, both messages land, and the feed shows both, the thread's call as `chatgpt` and yours as `console`. That is the point of watching both: the console does not stop you, it shows the overlap.

## Notes for the chat

**Leave note** sends text the owner typed to the chat that holds the agent, through the same path as an agent's `workdone-tell`. The gateway marks it `origin: "owner"` (only `owner_note` sets it) and the Events payload carries `data.origin: "owner"` on `agent.message`. Without that field the excerpt is agent text and treated as data. The `agent.message` payload schema gained this one optional field; ChatGPT needs **Refresh tools** to see it.

What happens after it is queued depends on the chat, and the console says which case it is without claiming delivery:

- A Work chat subscribed to `agent.message` on that machine is woken by the webhook.
- A regular chat gets it only while its link card is open, and it is held for up to an hour.
- With neither, nobody may get it.

An agent with a shell could call `owner_note` through the gateway launcher and forge `origin`, as it could already call any op. The marker tells ChatGPT what the gateway believes, not what an agent could prove.

## Loops

The console starts nothing on its own: no automatic nudge, answer, prompt or note, and no retries. Every action is one owner click. Console prompts do not ask for a `reply: true` result. See `docs/loop-risks.md`.

## Checking it

`bun test mcp/test/console.test.ts tests/console-ops.test.ts tests/inbox.test.ts tests/console-snapshot.test.ts`. The page itself is checked by hand: run `createConsole` over a fake `CallGateway` with `devNoAuth` and open it. After deploying, steer an agent a ChatGPT thread holds and check that both calls show in the feed, the thread's as `chatgpt` and yours as `console`.
