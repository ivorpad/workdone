# Close reliability: QA and handoff (2026-10-08)

Branch `close-reliability`, PR #3, residual work in issue #2. Gateway 0.17.0, MCP 0.15.0, WorkDone plugin 0.19.0. Not deployed.

## The incident

From the Mac gateway's audit log and state files, 2026-10-08 (UTC):

| Time | Call | What it was |
| --- | --- | --- |
| 08:17 | `read_agent wKR:p1`, `read_agent wKV:p1` | The chat reads both. |
| 08:34:44 | `close workspace wKR`, `confirm: true` | `wKR:p1` was the Codex agent `relay-decisions-api-research`, made by the bridge. Answered `{closed: "workspace", id: "wKR"}`. |
| 08:45:14 | `claim_agents take_over: true` (new lease) | Takes `wKV:p2` from the chat that was running a tool-dispatch test with it. |
| 08:45:25 | `close pane wKV:p2`, `confirm: true` | `wKV:p2` was an unnamed Claude pane the owner had opened by hand, the one on their screen. |

Every close in that sweep came with `confirm: true` and no approval card, and every one was answered with the ID it was given. Both work records (`wKR:p1`, `wKV:p2`) stayed `open` with `last_turn: gone`, so owed work survived the closes.

## Bugs and UX gaps

The gateway did what the chat asked. The chat picked the wrong target, and nothing in the protocol could catch that or report it truthfully afterwards.

Bugs (wrong behavior, shown on `main` by `tests/close-guard.test.ts` and a scratch script against `origin/main`):

| On `main` | Evidence |
| --- | --- |
| A working agent was killed on `confirm: true`, a go-ahead often given minutes earlier while it was idle. | `close wKV:p1` (working) returned `{"closed":"pane"}`, pane gone. |
| A close Herdr took without closing was reported closed. | Fake Herdr accepts `pane.close` and keeps the pane: `{"closed":"pane","id":"wKV:p2"}`, pane still there. |
| A close whose answer was lost failed although it happened, and its retry said the pane does not exist. | `herdr_timeout`, then `pane_not_found` on retry. |
| A repeat close was an error: `pane_not_found` through `request`, `not_bridge_pane` through `handle` (a false statement: the bridge made it). | Second close of a bridge-made pane: `pane_not_found`. |
| An approved card closed whatever the ID held when clicked, up to 15 minutes later, including panes that joined a workspace or an agent that replaced the one shown. | Race tests: `main` closed in all three cases. |
| A shell pane that got an agent between the lease check and the close was closed without a lease on it. | Race test: `main` closed it. |
| The test fakes' `pane.close` removed nothing, so the old tests passed without anything closing. | `tests/layout-agents.test.ts`, `tests/gateway.test.ts` fakes. |

UX gaps (the protocol gave the chat no way to get it right):

- `close` took no statement of what the caller meant, so a wrong ID could not be caught.
- Its result named only the ID it was given, so the chat reported the ID, not the agent.
- `list_panes` had no agent names, no holder and no `focused`, so "the one on my screen" could not be resolved. Herdr's pane records carry the agent's CLI, not its name.
- The approval card's reason said `close pane wKR:p1` with at most the CLI or name.
- The audit kept `close`'s arguments but not what it took.

Not a bug: work, leases and owed results were already unaffected by a close. `main` keeps the work `open` with its lease; the new tests pin that down.

## What `close` does now

In order, in `gateway/layout-ops.ts`:

1. Reads the target. If Herdr says it is gone and `closed.json` has a record for it (or for the tab or workspace close that took it), answers `outcome: "already_closed"` with when and by whom. Herdr never reuses pane or tab IDs, so the record cannot point at a new pane.
2. Builds `targets`: each pane's `pane_id`, `terminal_id`, CLI (`agent`), `name` (from `agent.list`), agent `session`, status and directory.
3. `expect`, when given, must match: for a pane close it must name that pane, and every field given must equal the live value; for a tab or workspace every pane in it must be listed. Otherwise `target_mismatch`, nothing closed. Expected panes already gone are fine.
4. A working agent is refused (`agent_working`) unless `even_if_working: true` or the console sent it. This runs before `needs_confirmation`, so no card is offered for it.
5. `needs_confirmation` names each pane in full (`codex "relay-decisions-api-research" wKR:p1, idle, in relay`) and returns `targets`. The MCP server binds them into the held call as `expect`, the way `answer_agent` binds `expected_dialog_id`.
6. Reads again just before the Herdr call. `target_changed` if a pane joined, left the allowed roots, or its terminal, CLI or agent session changed; `agent_working` again; and for calls that came through `request`, the lease check again on this read (`not_your_agent`).
7. Writes a `closing` record, calls Herdr, then reads Herdr back (up to 6 reads 250 ms apart, one read after a definite refusal):
   - gone: record `closed`, forget the created and disposable entries, return `{closed: kind, id, outcome: "closed", verified: true, panes}`;
   - still there: drop the record, `not_closed` with `still_open`;
   - unreadable: keep the `closing` record, `close_uncertain`. A repeat that finds the target gone answers `already_closed`.

Untouched by a close: `work.json`, leases (the closed pane stays listed, so `owed_work` still finds its holder), owed results, inbox entries. The watcher reports the agent `gone` as before.

`list_panes` adds `name` for agent panes, `focused` and `held_by`. `overview`, `get_agent` and other agent views add `focused` (only when true). The audit line for a close keeps `expect` (pane, CLI, name), `even_if_working`, and the outcome with the panes taken.

## Test evidence

New: `tests/close-guard.test.ts`, 17 cases on a fake Herdr shaped like the incident (`wKR:p1` named Codex agent, `wKV:p1` working Claude, `wKV:p2` unnamed focused Claude, `wKV:p3` shell):

| Area | Cases |
| --- | --- |
| Wrong ID `wKR:p1` vs `wKV:p2` | list_panes tells them apart; wrong ID with the owner's meaning refused; right ID with wrong belief refused; workspace with an unlisted pane refused; the meant pane closes and is named in the result |
| Active at close | working agent refused for pane and workspace, with and without confirm; `even_if_working` closes; console click closes |
| Race | starts a turn after checks; replaced by another agent; pane joins the workspace; shell gets an agent after the lease check; card approved after the agent changed |
| False closure report | Herdr keeps the pane (`not_closed`); answer lost but closed (`closed`); unreadable (`close_uncertain`), then repeat (`already_closed`) |
| Duplicate close | twice on a bridge-made pane; workspace twice; pane its workspace's close took; never-existed ID still `pane_not_found` |
| Shell-only pane | closes without a lease, result says `agent: null`, card text says "shell" |
| Lease conflicts | `needs_lease`; another conversation's agent, shell and workspace refused (`not_your_agent`); after `take_over` it closes and the work keeps the first lease |
| Work preservation | after close: `owed_work` item `gone`, `yours`, holder live, same `work_id`; lease still lists the pane; `settle_work` works |

MCP: `mcp/test/confirm.test.ts` adds "a held close is bound to the panes its card names, and a chat's expect reaches the gateway". The existing card test still passes unchanged, as the case of a gateway that sends no `targets`. Audit: `tests/approval-audit.test.ts` adds the close outcome and `expect` fields.

Against `main` (same test file in a scratch worktree at `origin/main`): 0 pass, 17 fail. Most fail on behavior; the two work-preservation cases fail only because `main` has no `outcome` field.

`bun run check` on the branch: typecheck clean, 851 pass, 0 fail, 52 files (baseline on `main`: 832 pass once `issuer/` dependencies are installed).

CI: the repo had no workflow. `.github/workflows/check.yml` runs `bun run check` on ubuntu-latest with Bun 1.4.0 after installing zsh and the root, `mcp/` and `issuer/` dependencies. First run (37756982184): 844 pass, 7 fail, all in `tests/pane-exec.test.ts`, whose fake Herdr runs commands with zsh, missing on the runner. With zsh installed (run 37757216194): 851 pass, 0 fail.

Herdr's not-found codes (`pane_not_found`, `tab_not_found`, `workspace_not_found`) were checked read-only with `herdr pane get` on an ID that does not exist.

Live check before deploying (Mac, Herdr server 0.9.1): the new gateway code ran through its real stdin entry point with a scratch config whose only allowed root was an empty scratch directory, so no existing pane was visible to it. It made a throwaway shell workspace and then:

| Call | Answer |
| --- | --- |
| `close` without confirm | `needs_confirmation`, "shell wMH:p1, in live-root" |
| `confirm`, `expect` agent claude | `target_mismatch`; Herdr still shows the pane |
| `confirm`, `expect` agent null | `outcome: closed`, `verified: true`; `herdr pane get` then says `pane_not_found` |
| the same close again | `outcome: already_closed` |

It found one bug the in-process tests could not: `herdr-gateway.ts` sent an error's details over the wire only for a menu, so `targets` never reached the MCP server and the approval card would have held the bare call. Fixed in 781b727 (`wireDetails`); rerun live, `targets` came back and closed a second scratch pane when replayed as `expect`. Both scratch workspaces are gone.

## Files

| File | Change |
| --- | --- |
| `gateway/layout-ops.ts` | the close protocol above; `ownerMayClose` names panes in full and returns `targets` |
| `gateway/leases.ts` | `closeGuard` for close's last read; `LEASE_CHECKED`; a repeat close of a closed pane passes the lease check |
| `gateway/gateway.ts` | marks calls whose lease check ran; `list_panes` names and `held_by` |
| `gateway/state.ts`, `gateway/state-journal.ts` | `closed.json` (newest 200 records), validated like the other state files |
| `gateway/views.ts` | `focused` |
| `gateway/herdr-gateway.ts` | audit of `expect`, `even_if_working` and the close outcome |
| `mcp/src/tools.ts` | `close` gets `expect` and `even_if_working`, new description; `list_panes` description; MCP 0.15.0 |
| `mcp/src/confirm.ts`, `mcp/src/gateway-client.ts` | held close bound to `targets` |
| `plugin/herdr-remote/skills/herdr-remote/SKILL.md` | how to pick the pane, pass `expect`, and report only the outcome |
| `docs/loop-risks.md` | the close guard |
| tests | `tests/close-guard.test.ts` (new), fakes in `tests/layout-agents.test.ts` and `tests/gateway.test.ts` now close for real, `mcp/test/confirm.test.ts`, `tests/approval-audit.test.ts` |
| `.github/workflows/check.yml` | CI |

Commits: a9809d6 (close), ba430e1 and b2a066c (CI), 4b09fa2 (this file), 92661c5 (a repeat close names only the asked pane), 781b727 (close details over the wire).

None of the files with another writer's uncommitted edits in the main checkout (console, inbox, MCP config and server, watch card) were touched. The work was done in a separate worktree on branch `close-reliability`.

## Rollout

Nothing is deployed. Follow the `workdone-release` steps, in this order:

1. **Gateways first** (Mac with `scripts/install-gateway.sh`, OVH with `scripts/deploy-ovh.sh`, syno only if wanted). A 0.17.0 gateway behind the old MCP still refuses working agents, re-reads before closing and reports the outcome from Herdr. The old MCP schema strips `expect`, so the wrong-ID check waits for step 2.
2. **MCP 0.15.0 on OVH.** A new MCP in front of an old gateway sends `expect` and `even_if_working`, which the old gateway ignores: the wrong-ID check is silently off there. That is why gateways go first.
3. **WorkDone plugin 0.19.0** upload and Refresh tools on both apps. Open chats keep the old tool list; a new chat gets `expect`.

Migration: `closed.json` appears in the gateway state directory on the first close. A rolled-back gateway does not read it (it validates only the files it knows), so rollback is a reinstall of the previous version. The success result keeps `closed: <kind>` and `id`; `outcome`, `verified` and `panes` are added. New error codes callers may see: `target_mismatch`, `target_changed`, `agent_working`, `not_closed`, `close_uncertain`. The console treats them as refusals in its feed ("close refused (not_closed)"); issue #2 tracks wording that fits.

Behavior change to tell the owner: from a chat, a working agent no longer closes on `confirm: true` alone. Saying "close it even though it's working" makes the chat pass `even_if_working`. The console's Close button still closes a working agent.

## Residual work

Issue #2: a conditional close in Herdr (one round trip remains between the last read and `pane.close`), making `expect` required once every deployed MCP sends it, the same protocol for `remove_worktree`, pane IDs that change on `move_pane` while leases and work keep the old ID, closed panes left in leases, console wording, and `focused` being Herdr's server focus rather than per client.
