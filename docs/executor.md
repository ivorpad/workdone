# WorkDone in Executor

[Executor](https://executor.sh) keeps the accounts for the services you use and gives any agent one MCP endpoint to reach them. `executor/workdone` is an Executor app that wraps WorkDone's MCP server, so an agent that is not ChatGPT (Claude Code, Codex, Cursor, a cloud agent) can list, start and prompt your Herdr agents through Executor. Executor holds the WorkDone sign-in. The agent only ever holds its own Executor connection.

## Access levels

The owner picks one on the app's Accounts tab, under "WorkDone access level". It is a radio button per saved account and each account is one level, so changing it is one click and no new sign-in.

| Level | The agent sees | Executor asks the owner before |
| --- | --- | --- |
| Read only | `overview`, `get_agent`, `read_agent`, `wait_agent`, `owed_work` and the other listing tools | nothing |
| Read, and ask me before it starts or prompts agents | the above, plus leases, layout and the tools that start, prompt, steer or answer agents | `spawn_agent`, `start_agent`, `prompt_agent`, `steer_agent`, `send_agent_keys`, `answer_agent`, `supervisor_nudge`, `settle_work`, `wake_machine` |
| Everything, asking before risky tools | every WorkDone tool | `settle_work`, `wake_machine`, `answer_agent`, and each host tool that is not read-only: `exec`, `run_command_in_pane`, `send_pane_input`, file writes, `close`, `remove_worktree`, `set_agent_approval`, browser runs, `ask_openclaw` |

At every level a call that carries `confirm: true` goes back to the owner, because that flag means the owner already said yes to a gated operation and Executor does not take the caller's word for it. ChatGPT's approval and link cards, `watch_here` and the event hooks are never offered. A tool added to WorkDone later counts as a host tool, so only the top level sees it.

The rules live in `executor/workdone/policy.ts`. `tests/executor-policy.test.ts` holds them to WorkDone's own tool registry, so a rename or a changed annotation in `mcp/src/tools.ts` fails a test instead of quietly moving a tool to another level.

## Connect the agent so approvals mean something

Executor's default mode has the agent relay each approval to you, so a hijacked agent could answer for you. Connect it with `elicitation_mode=browser` (`https://mcp.executor.sh/mcp?elicitation_mode=browser`) and the approval waits for you on a signed-in page instead.

Also give the agent a scoped connection (Connect page in the dashboard) that reaches only this app. A plain connection acts as you and can call Executor's own management tools, which includes relinking the access level and reading your other apps.

## What WorkDone has to allow

Executor Cloud's servers call WorkDone from outside, and the setup that ChatGPT uses lets nobody else in. Two changes, both on OVH.

**The issuer.** Executor registers itself with a client ID metadata document (public PKCE client). The live sign-in used `https://v2.executor.sh/oauth/client-metadata.json` with callback `https://v2.executor.sh/api/oauth/callback`, while Executor's API reports `executor.sh` as its redirect host, so it uses both names. The issuer only fetches such documents from `ISSUER_CLIENT_HOSTS`, which defaults to `chatgpt.com,openai.com`, and it matches suffixes. Until `executor.sh` is on the list the sign-in stops at `invalid_client: client_id metadata document fetch not allowed`. Add `ISSUER_CLIENT_HOSTS=chatgpt.com,openai.com,executor.sh` to `/etc/workdone-issuer/env` and restart `workdone-issuer`. `scripts/deploy-issuer.sh` rewrites that file on every run, so a redeploy needs `EXTRA_CLIENT_HOSTS=executor.sh` in front of it to keep the line.

The consent page used to send `form-action 'self'`, and Chromium checks that against the redirect after a form post, so Approve left the browser on the consent page with nothing sent to Executor. The password step and the grant worked, which is why a second Connect went straight through without asking for either. The page now adds the client's redirect origin to `form-action` (`issuer/src/interactions.ts`, with a test). An issuer deployed before that change stalls the same way on the first Approve in a Chromium browser, and on any later reconnect, such as after the 30-day refresh token lapses.

**Caddy.** `/mcp` answers 403 to every address outside OpenAI's connector list (`deploy/Caddyfile.issuer`). Executor's apps run on Cloudflare Workers, which has no address list of its own, so a request from Executor is refused before the token is looked at. One way through is to delete only the `respond @not_openai 403` line in the `/mcp` block and reload Caddy. `scripts/executor-open-mcp.sh ISSUER_HOST_NAME` does exactly that, with a backup, `caddy validate` and a rollback, and `--close` puts the line back. The `@not_openai` matcher stays, so `scripts/openai-allowlist.sh` keeps working. The issuer-signed token is then the only gate on `/mcp`, and the MCP already demands it (without one it answers 401 before parsing anything else). The other way is to allow Cloudflare's published ranges (`https://www.cloudflare.com/ips-v4` and `ips-v6`) next to OpenAI's. That filters less than it sounds, since anyone can run a Worker, and `scripts/openai-allowlist.sh` would need to learn the extra lists or its weekly run overwrites them. The issuer's login page and token endpoint are public already.

Executor then holds a refresh token for the owner on every machine in `principal-grants.json`. That is the real cost of the hosted route. Hiding `exec` does not shrink it much, since `prompt_agent` on a full-access Claude Code or Codex agent runs anything. The access level and the approvals are what limit it.

## Deploy the app

The repo is public, so `WORKDONE_HOST` in `executor/workdone/providers.ts` is a placeholder. Deploy a copy with the issuer's host (the host of `MCP_RESOURCE`, in `.context/real-values.md`) and never commit it.

1. Keep `package.json` pinned to the `apps` version Executor reports (`framework.release`, `0.0.1-beta.95` when this was written).
2. Type-check, as Executor's app-authoring skill says to: `npm install --ignore-scripts --no-package-lock`, then `npx -y -p typescript@7 tsc --ignoreConfig --noEmit --strict --skipLibCheck --module nodenext --moduleResolution nodenext --target es2022 index.ts`.
3. Create and deploy the five files (`index.ts`, `providers.ts`, `policy.ts`, `instructions.ts`, `package.json`) through the Executor MCP, `appManagement.create` then `appManagement.deploy`. Later edits go through `appManagement.commit`, then deploy.
4. On the app's Accounts tab, pick a level and connect WorkDone. The issuer asks for the owner's password and an Approve. Executor renews the hour-long access token itself, and asks for a reconnect if renewal ever fails.

The level accounts are not credentials. Each one is an empty sign-in method of the "WorkDone access level" provider, named for its level. Renaming a method label in `providers.ts` makes a new provider and drops them, so the three accounts have to be connected again.

## What does not carry over

- No wake-ups. The agent polls with `wait_agent` and `owed_work`. The cards, `watch_here` and native Events only exist in ChatGPT.
- One Executor `execute` program runs 5 minutes at most, with 100 tool calls and 64 KB of output. Use `call` for single steps and keep `wait_agent` timeouts at 30 to 60 seconds.
- WorkDone's own server instructions are written for ChatGPT, so the app replaces them with `executor/workdone/instructions.ts`.
