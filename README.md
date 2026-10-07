# WorkDone

https://github.com/user-attachments/assets/32e2297c-b4e1-45ae-89b2-f6add0dd3fc9

![A ChatGPT chat linked with the agents on a Mac: a message an agent sent with workdone-tell and the agent's reply, shown in the link card](docs/images/link-card.png)

WorkDone lets a ChatGPT chat run the coding agents (Claude Code, Codex, Cursor) that live in Herdr panes on your own machines. From the chat you can see what every agent is doing, read its last reply, start agents by name, prompt or steer them, and answer their permission menus. It also gives ChatGPT a file and shell API on the same machines.

## Why

I wanted to keep working with my agents while away from the keyboard: out walking or jogging, at the gym, or driving with CarPlay. ChatGPT's voice mode is already on the phone and in the car, so WorkDone makes it the voice front end. I ask what the agents are doing, hear their replies, start one with a task, or answer the question it's stuck on, all without a screen. That is also why you start agents by saying the CLI, model and effort ("claude opus on extra high") and why misheard words are matched loosely.

It is not a way around ChatGPT's or any agent's usage limits. The agents run on your own machines under your own accounts, exactly as they would if you typed to them.

## Why not just ChatGPT Work or the Codex app

Work and Codex (now one ChatGPT desktop app with Chat) run OpenAI's agent on OpenAI's models, in OpenAI's cloud or in that app on your computer. They need no setup and come with a sandbox. WorkDone is for when the agents you want to talk to already exist somewhere else:

- **Any agent CLI, not one vendor's.** Claude Code, Codex CLI and Cursor (and through Cursor, Grok, Gemini, Kimi and others), each under its own subscription. ChatGPT is the voice and the coordinator, and it doesn't have to be the one writing the code.
- **The same sessions you use at the desk.** Agents live in Herdr panes on your machines. Start one by voice in the car and it is sitting in a terminal when you get home, with its whole transcript. Nothing is handed off or synced.
- **Your real environment.** The agents run in your checkouts with your shell, keychain, ssh-agent, `gh` login and local services, not in a fresh clone.
- **Several machines at once.** A Mac that sleeps and an always-on VPS (and a NAS here) appear as one list. Work started on the VPS keeps going while the laptop is closed.
- **Your rules.** Gated operations (push, merge, `rm -rf`, deploys) wait for the owner. Approval policies are set per agent, and every call goes to an audit log on the machine that ran it.

The cost is that you run and secure all of it yourself: a VPS, an OpenAI tunnel, SSH keys, an OAuth issuer for Events, and screen parsing of each CLI's menus that a CLI update can break. If Work or Codex does the job, it is less to look after.

## How it fits together

WorkDone is built on the pieces OpenAI shipped for ChatGPT plugins in 2026:

- **[Plugins](https://developers.openai.com/plugins).** A plugin bundles an MCP server, skills and optional UI, and runs in ChatGPT Chat, Work and Codex. WorkDone ships two: `plugin/herdr-remote` (the tools and the skill that tells ChatGPT how to use them) and `plugin/workdone-events` (the event subscriptions).
- **Secure MCP Tunnel.** It lets ChatGPT reach an MCP server that only listens on the VPS's loopback, with no open port.
- **MCP Apps.** Tools can return small HTML cards that render inside the chat. WorkDone uses them for the Approve card (a held command with Approve and Decline) and the link card, which can also wake the chat with a new message (`ui/message`). That is the only way to reach a regular Chat unprompted.
- **[MCP Events](https://developers.openai.com/plugins/build/mcp-events)** (protocol `2026-07-28`). ChatGPT subscribes to an event and the server calls a signed webhook when it happens, which wakes the chat. WorkDone offers `agent.finished`, `agent.asks` and `agent.message`. It needs OAuth (the `issuer/` here) and, for now, a Work chat.

Below ChatGPT, everything is this repo: the MCP server on the VPS, a forced-command gateway on each machine reached over ordinary OpenSSH on a tailnet, and Herdr's socket API on each machine. One person built it for their own setup, a Mac that sleeps and an always-on Linux VPS (called `ovh` throughout).

```text
ChatGPT → OpenAI Secure MCP Tunnel → MCP server on the VPS (127.0.0.1:8787)
       → OpenSSH over Tailscale → forced-command gateway on the Mac → Herdr socket, files, shell
       → OpenSSH to 127.0.0.1   → forced-command gateway on the VPS  → same
```

Everything runs on Bun.

## Read this first

This gives a chat model a shell on your machines. Each gateway has capability flags (below), allowed roots and a list of operations that need the owner's confirmation, but with `allowExec` on, ChatGPT can run anything your user can. The generated model list also starts every agent with its permission prompts off. Read [Where the security checks live](#where-the-security-checks-live) before you deploy, and keep the No Auth listener (port 8787, reached only through the Secure MCP Tunnel) off the public internet. Only the OAuth listener for Events may be exposed.

## Status

Works day to day, from ChatGPT to the machines: listing and reading agents, spawning and prompting them, answering menus, the approval card, files and exec.

The other direction, an agent telling ChatGPT something without being asked, depends on where the chat runs:

- **Native MCP Events** (`agent.finished`, `agent.asks`, `agent.message`) work in ChatGPT **Work** chats, which is where [OpenAI's docs](https://developers.openai.com/plugins/build/mcp-events) say Events are available (Work on the web, Work in the desktop app with Cloud selected, and dots). On 2026-10-02 a Work chat with the WorkDone Events plugin subscribed, passed the signed callback challenge, and woke on its own to report a finished agent. In a regular Chat, ChatGPT lists the events but never calls `events/subscribe` ([openai/codex#49665](https://github.com/openai/codex/issues/49665)). Events need the OAuth issuer in `issuer/`, and the callback host must be in `events.callbackHosts`. ChatGPT's is `connectors.api.openai.com`.
- **The card fallback** (`watch_here` and `workdone-tell`) is what a regular Chat gets. It wakes the chat with `ui/message` from an MCP Apps card, so a message only gets through while that chat's card is open, and it is held for at most an hour. A closed tab, the mobile app, or a chat that has scrolled the card away means the agent's message waits or is lost. In a Work chat, `workdone-tell` messages arrive as the `agent.message` event.

## Docs

| | |
| --- | --- |
| [docs/INSTALL_AND_SETUP.md](docs/INSTALL_AND_SETUP.md) | Install runbook, written for an agent to follow |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Step-by-step deployment: placeholders, human steps, a check after each phase, known failures |
| [docs/chatgpt-link.md](docs/chatgpt-link.md) | The two-way link between a chat and an agent, approval policies, what ChatGPT does and doesn't do |
| [docs/mcp-events.md](docs/mcp-events.md) | Native MCP Events, OAuth and the callback network policy |
| [docs/console.md](docs/console.md) | The owner's console: one page to see every agent, who steers it, and what waits on you |
| [docs/loop-risks.md](docs/loop-risks.md) | Risks of letting a chat and its agents wake each other |
| [plugin/herdr-remote/skills/herdr-remote/SKILL.md](plugin/herdr-remote/skills/herdr-remote/SKILL.md) | The instructions ChatGPT gets. They name the author's machines (`mac`, `ovh`, `syno`) and browser tools, so edit them for yours |
| [skills/workdone-link/SKILL.md](skills/workdone-link/SKILL.md) | The skill for agents talking back to the linked chat |
| [issuer/README.md](issuer/README.md) | The single-owner OAuth issuer for Events |

## Layout

| Path | Runs on | What it is |
| --- | --- | --- |
| `gateway/` | each machine | Forced command for that machine's bridge SSH key. Reads JSON requests on stdin, talks to Herdr's socket API (`~/.config/herdr/herdr.sock`) with typed calls, and runs the file and shell ops. `watcher.ts` is the separate notification loop. |
| `mcp/` | OVH | Streamable HTTP MCP server (stateless, JSON responses). Each tool call is one `ssh` round trip to the chosen machine's gateway. |
| `plugin/herdr-remote/` | ChatGPT / Codex | Plugin manifest and skill. `.app.json` is created from `.app.json.example` once ChatGPT assigns the app ID. |
| `config/` | both | Example configs: `mac-gateway`, `ovh-gateway` (gateways) and `ovh` (MCP server, one entry per machine). |
| `deploy/` | both | systemd units for OVH, launchd plist for the Mac watcher. |
| `scripts/` | both | Install a gateway or the watcher, render the `authorized_keys` line, set up the tunnel on OVH. |

## Tools

Every tool takes an optional `machine` (`mac`, `ovh`, and whatever `scripts/add-machine.sh` added). It is a plain string, not an enum, so ChatGPT's cached tool list does not need a refresh when a machine is added. Listing tools called without one (`bridge_status`, `overview`, `supervisor_status`, `owed_work`, `coord_snapshot`, `prunable_agents`, `list_panes`, `list_workspaces`, `list_repos`) ask every machine and key the answer by machine name. Pane, tab and workspace IDs only mean something on the machine that issued them.

- **Agents:** `overview` (every agent with status, git branch, the start of its last reply, the dialog if blocked), `prunable_agents` (which agents are finished and what to `close` for each when the owner asks to clean up; it closes nothing, reads agents and panes in one Herdr `session.snapshot`, or the two lists on a Herdr without it), `get_agent` (`explain: true` adds Herdr's `agent.explain` verdict: the rule that matched and why a state was skipped, to tell a Herdr detection miss from ours), `read_agent` (`source: reply` reads the last answer from the Claude or Cursor transcript instead of the screen), `prompt_agent` (with `wait`, returns the reply), `wait_agent` (one agent or several in `targets`: returns when any stops working, with every agent's status, and a timeout is an answer, not an error), `watch_agent`, `send_agent_keys`, `spawn_agent` (place, start, wait, first prompt in one call; a worktree goes in `worktreeRoot` or next to the repo, inside the allowed roots or refused; once the agent has started, a failed first prompt, binding, reply request or watch comes back as `prompt_error`, `task_error`, `result_error` or `watch_error`, with the agent in the lease and its work open), `start_agent`. Kinds come from `agentKinds`; `cursor` is `cursor-agent`, and without an `agentKinds` list a gateway offers it where `cursor-agent` is installed.
- **Owed work:** a spawn, a start, or a chat's first prompt or steer to an agent with no open work opens a work record (`work.json`, `gateway/work.ts`) and returns its `work_id`. It stays open through finished turns, failed (API error) turns, exits and the agent leaving the allowed roots (status `left`), and closes only on `settle_work` (`accepted` or `dropped`, on the user's word; it closes no pane) or when its bound coordination task is merged complete. Work records, not watches, decide what is owed. `owed_work` (read-only) lists open work and, for an agent with none, unanswered tells and questions and owed `reply: true` results; a plain finished or gone turn is not owed. Each item has its state, holder lease (tail, label, origin `spawn` or `claim`), `settle` (`work_id`, or `target` for an agent with no open work) and a one-line `next`. An `owed` digest rides on `overview`, `get_agent`, `wait_agent`, `supervisor_status` and the calls that start or prompt agents when anything is owed. `spawn_agent` without a lease still makes a separate lease (origin `spawn`), so a chat should claim once and pass its lease.
- **Menus and steering:** `answer_agent` answers the menu an agent shows (approval, question, folder trust, update notice) by option number, plus `text` for an option that opens a field, and `options` for a multi-select. `gateway/dialog.ts` reads the menu off the screen and knows each CLI's keys: Claude Code and Codex take the digit (Claude's folder trust has no numbers, so arrows and enter), Cursor the key in parentheses or the letter in brackets, and a multi-select flips boxes with digits then tabs to its review step. `steer_agent` types a message into a working agent: Claude Code and Codex queue it until the current tool call ends, and Cursor gets a second enter so it goes in at once. It refuses while a menu is up, since its enter would answer the menu, and prompts an idle agent instead. `get_agent`, `read_agent` and `overview` return the parsed menu as `choices`. Codex's folder trust, update and model notices, which Herdr reads as idle, count as `attention: dialog` too, and `prompt_agent` refuses to type into any of them. Keys go one at a time with a pause, and text apart from its enter: in one burst the CLIs dropped keys or took the enter before the text. Letters go as Herdr key presses, not typed text: Cursor's approval menus ignore a pasted `y`. The screens this was built from are in `tests/fixtures/screens`.
- **Permission policies:** `set_agent_approval` saves `ask`, `permissions`, `all_permissions` or `default` for one claimed agent. `ask` leaves permission, trust and notice menus for the owner's decision. `permissions` approves recognized ordinary menus using allow once; `all_permissions` also covers recognized gated agent permissions when the owner explicitly authorizes that scope. `default` removes the override. Policies expire within 24 hours and stop on lease release, takeover, unwatch or a detected session change. They govern visible menus, not an agent's launch flags, ordinary questions or direct shell commands. [Policy details](docs/chatgpt-link.md#choose-how-an-agent-handles-permissions) include session and launch-mode limits.
- **Go-ahead menus:** `goAhead` in `gateway/dialog.ts` recognizes command and file permissions, folder trust, and routine update and model notices. The notifier and agent operations answer these only when the effective policy allows them. They use allow once, skip updates and keep the pinned model; persistent always-allow rules are not selected. Results list successful answers in `auto_approved`, and the audit log records `auto_approve` with the menu text. `choices` includes `kind` (`permission`, `trust`, `notice`, `gated`, `question`), `go_ahead` and `dialog_id`. `blocked` can mean a permission or a question. Once the owner answers or delegates a choice, ChatGPT rereads the menu and calls `answer_agent` with the current `expected_dialog_id`; `ask` does not prevent that manual answer. A new prompt or steering message cannot answer a menu. One process answers a pane at a time. Harness deny rules refuse without a menu and cannot be approved here. `"autoApprove": false` disables automatic approval.
- **Agents by CLI, model and effort:** `spawn_agent` and `start_agent` take `kind` (the CLI), `model` (a family such as `opus` or `grok`) and `effort`; see [Agents](#agents). `bridge_status` lists each machine's CLIs in `agent_kinds` and, under `agents`, each CLI's models with their efforts and its `default_model`.
- **Owner's calls:** `gateway/gated.ts` gates git push, commit, merge, rebase, reset --hard, branch delete and clean, GitHub writes (`gh pr/issue/release` edits, `gh api` POST/PATCH/PUT/DELETE), `rm -rf` and deploys. `answer_agent` accepts `confirm: true` when the owner's existing instruction or current decision authorizes the operation; ChatGPT should not request the same authorization again. A saved `all_permissions` policy can also approve a recognized gated agent permission. Direct `exec`, `run_command_in_pane` and `send_pane_input` still require `confirm: true` for covered authorization. Without it, these tools return `needs_confirmation`. Audit records identify confirmed calls and automatic policy answers.
- **Approve by click or chat:** the MCP server keeps each refused gated call for 15 minutes under a `pending` id (`mcp/src/confirm.ts`). `request_confirmation` shows a card with the exact held command or menu and Approve / Decline. Its app-only `confirm_pending` runs the held call once with `confirm: true` and reports the result. An approval in chat also works: ChatGPT applies it through the original tool with `confirm: true`, rereading a menu and passing its `expected_dialog_id` before answering. Use a card when the owner's decision is still needed, not after they already authorized the operation. A held menu answer is bound to that dialog; a changed menu requires a new decision. Pending calls live in the MCP server's memory, so a restart drops them.
- **Talking with ChatGPT:** in a Work chat, native MCP Events (`agent.finished`, `agent.asks`) wake the subscribed chat through a verified webhook when a watched agent completes a turn or asks a question; [docs/mcp-events.md](docs/mcp-events.md) covers OAuth, subscriptions and the callback network policy. In a regular Chat, `watch_here` / `watch_next` and the [card link](docs/chatgpt-link.md) are the fallback, with the limits in [Status](#status). `scripts/tell.sh` messages arrive as `agent.message`, even from an agent no chat has linked.
- **Results without polling:** `reply: true` on `spawn_agent`, `start_agent`, `prompt_agent` or `steer_agent` is opt-in and owes the caller the agent's next final result. The turn that ends it (or the agent's exit) puts `data.result` on that one `agent.finished` event: the `result_id` the call returned, `status`, `summary` (the agent's last line starting `RESULT:`), `commit`, `tree`, `clean`, `changed`, `branch` and the launched model and effort. A linked card gets it as the reply. A question leaves it owed, and asking again while one is pending returns the same id, so it is one wake. A wake that never reaches the chat loses nothing: `owed_work` has the result as `last_result`. No event name was added; the payload has an optional field, so ChatGPT needs **Refresh tools** to see it.
- **Supervisor:** `supervisor_status` (read-only, watched agents only) compares the commit, tree and diff digest the watcher records at each finished turn with the live git state. Two finished turns without a new commit or diff are a stall (a loop when the answer repeats too), and the advice is one `supervisor_nudge` per agent session, then a handoff or a model/effort change. `prune_close` comes only after a commit beyond the agent's start landed with a clean tree (work with no commit, such as research, never lands; `settle_work` ends it), and it is not permission to close: `close` needs the owner's go-ahead (a `confirm: true` after they ask, the approval card, or the console) unless every pane it closes was spawned with `disposable: true`. Every launch records the model and effective effort in its result, on the watch (`get_agent.watch.launch`) and as an `agent_launch` audit line. [docs/loop-risks.md](docs/loop-risks.md#what-the-code-enforces) lists the limits.
- **Attention:** `overview`, `get_agent` and `read_agent` add `attention` to Herdr's status: `dialog` (a menu, including Cursor's workspace trust prompt, which Herdr reads as idle) or `question` (the agent stopped and the end of its last reply asks the owner something). `watch` shows whether the agent is watched and the last thing reported or answered about it.
- **Layout:** `list_workspaces`, `list_panes`, `read_pane`, `split_pane`, `create_workspace`, `create_tab`, `rename`, `focus`, `move_pane`, `close`, `send_pane_input`.
- **Repos:** `list_repos`, `list_worktrees`, `create_worktree`, `remove_worktree`. A new worktree goes next to the repo in `<repo>.worktrees/<branch>`, or in `<worktreeRoot>/<repo key>/<branch>` (its key in `repos`) when `gateway.json` sets `worktreeRoot` (for a repo that is itself an allowed root, whose sibling folder would be outside). The path is checked against the allowed roots before anything is made (`path_not_allowed`): Herdr's default, `~/.herdr/worktrees`, is normally outside them, and an agent started there could not be reached.
- **Browser:** `browse` starts a Jev browser run (`jev-browser run URL GOAL...`) in OVH's persistent signed-in Chromium and returns a run id at once; the run is detached from the ssh call, so it outlives it. `browse_status` gives a run's state (`running`, `done`, `blocked`, `failed`, `stopped`, `lost`), the JSON summary with each goal's status and final URL, the end of the step log and `final_pages` (each goal's last URL, title and the start of its visible text: 800 characters by default, `text_chars` up to 6000; read from the trace, since the file tools do not serve the gateway's state), or the last 10 runs. `browse_stop` kills the run's process group. Runs live in `<stateDir>/jobs/<id>/` (`job.json`, `log.txt`, `summary.json`, `trace.json`, `exit`); the newest 50 are kept. A gateway offers it with `"browser": {"command": ["~/.local/bin/jev-browser", "run"], "cwd": "~/src/jev-browser"}` (the cwd holds jev-browser's `.env`) and `allowExec` on. Browser results are not masked, so URLs stay usable.
- **exec in your own session:** with `"execInPane": true` in a gateway config (the author turns it on for the Mac and the VPS), `exec` runs the command the way you would after `ssh` and a new Herdr pane: in a tab of a `workdone exec` workspace, in your interactive zsh, so `.zshrc` (aliases, functions, PATH), the keychain (`gh`'s token on the Mac) and your ssh-agent are there. The command runs in a subshell of that shell, sourced from a file, with stdin, stdout and stderr through files; the gateway waits for its exit code, reads the output and closes the tab. The workspace stays, so you can watch commands appear. It costs about a second a call (a new tab and shell). A timeout sends ctrl+c. Without the switch, `exec` runs as the gateway's own ssh login (`zsh -lc`, no keychain, no `.zshrc`): on the Mac that is why `gh` failed with 401 from ChatGPT while it worked in the agents' panes. The result has `via: "pane"` when it ran in a pane.
- **Host:** `exec` (shell command, returns exit code and output), `run_command_in_pane`, `list_dir`, `read_file` (text; PDF and Office files as Markdown through `documentConverter`; images as MCP image content), `show_image` and `screenshot` (the image on a card the owner sees, and to the model as with `read_file`; `screenshot` needs macOS and `execInPane`, because only a pane under the owner's terminal has Screen Recording permission), `write_file`, `move_path`, `delete_path` (moves into `~/.local/state/herdr-chatgpt/trash`), `search_files` (ripgrep).

Each gateway rereads `gateway.json` on every call, so a capability turned off takes effect on the next call:

| Flag | Unlocks |
| --- | --- |
| `allowExec` | `exec`, and extra `args` for `spawn_agent` / `start_agent` |
| `allowFileRead` | `list_dir`, `read_file`, `search_files` |
| `allowFileWrite` | `write_file`, `move_path`, `delete_path` |
| `allowRawPaneRun` | `run_command_in_pane`, `send_pane_input` |
| `allowCloseAny` | `close` on panes, tabs and workspaces the bridge did not create |
| `allowWorktreeRemove` | `remove_worktree` |

With `allowExec` on, the allowed roots stop being a boundary for anything but the file tools: a command can `cd` anywhere the user can.

`autoApprove` is on unless set to `false`: it enables automatic menu approval according to each agent's effective policy, and `bridge_status` shows it as `capabilities.auto_approve`.

## Agents

ChatGPT starts an agent by naming the CLI, the model and, if you like, the effort: "claude opus on extra high", "cursor grok", "codex sol". Dictated words are matched loosely: "Gemini Flash" is `gemini-flash`, "Extra High" is `xhigh`, "maximum" is `max`. Without a model, the CLI starts on its default model from the list below, or on its own configured default when the list has none for it.

**CLIs.** A gateway offers the agent CLIs installed on its machine, out of the 24 kinds Herdr 0.9.1 can start (`AGENT_CLIS` in `gateway/config.ts`): Claude Code, Codex, Cursor, OpenCode and pi, plus Gemini CLI, Copilot, Amp, Droid, Qwen and the rest. Set `agentKinds` in `gateway.json` to offer fewer. Claude Code, Codex, Cursor, OpenCode and pi get a model list; any other CLI starts on its own default model.

**Models.** `bun scripts/agent-models.ts` asks each installed CLI what it offers and writes `~/.config/herdr-chatgpt/agent-models.json`, which `gateway.json` points at with `"agentModels"`. Per CLI it keeps one entry per model family, the family's newest version, and drops a family whose newest version is a generation behind its vendor's (Codex's `gpt-5.5` once `gpt-6` is out). Rerun it when a CLI ships a model; `bridge_status` shows ChatGPT the current list. Where the models come from:

| CLI | Models from | Model names | Effort |
| --- | --- | --- | --- |
| Claude Code | `CLAUDE_CODE` in the script, pinned by full ID | `opus` (default), `fable`, `sonnet` | `--effort` low to max |
| Codex | `codex debug models` | `sol` (default), `astra`, `luna`, `reserve` | `-c model_reasoning_effort`, as Codex lists it per model |
| Cursor | `cursor-agent models` | `auto` (default), `grok`, `gemini-flash`, `gemini-pro`, `kimi`, `glm`, `composer`, `muse-spark` | part of Cursor's model ID, `-fast` variants included |
| OpenCode | `opencode models openrouter` | OpenRouter's `~vendor/family-latest` routes: `grok`, `kimi`, `glm`, `deepseek-pro`, `gemini-pro`, ... | none |
| pi | `pi --list-models openrouter` | the same routes | `--thinking` low to max, where the model thinks |

The names in the table are what this generator produced on the author's Mac on 2026-10-02. A vendor's models go through its own CLI when that CLI is installed: Claude models only in Claude Code, GPT models only in Codex. On a machine without Claude Code, Cursor, OpenCode and pi offer them instead.

**Full access.** Every listed model starts with its CLI's no-prompt mode (`FULL_ACCESS` in the script): `--dangerously-skip-permissions` for Claude Code, `--dangerously-bypass-approvals-and-sandbox` for Codex, `--force --trust` for Cursor and `--auto` for OpenCode; pi has no permission prompts. So agents run pushes, commits, merges and deletions without a menu, and the gated list only covers what ChatGPT runs itself (`exec`, `run_command_in_pane`, `send_pane_input`) and menus agents still show. Protect what must stay the owner's call on the server side, e.g. GitHub branch protection on `main`. Remove the flags from `FULL_ACCESS` and rerun the script if you want agents to ask.

## The browser for `browse`

`browse` (gateway config `browser`, see `config/ovh-gateway.example.json`) starts a run in a persistent, signed-in Chromium on an always-on machine. That browser is not part of this repo. Keep its CDP port and viewer on loopback, and put the viewer on your tailnet with `tailscale serve`, never `tailscale funnel`. Every site its profile is signed in to is a site ChatGPT can act on as you, so sign in only to the ones you want it to use.

`scripts/export-browser-sessions.py` copies signed-in sites from a local Chrome profile into that browser, skipping banks, payments, cloud consoles, government sites and work sign-ins (`EXCLUDE` in the script). It depends on two tools that are not in this repo (`chrome-canary-cdp` and `ovh_session.py`), so treat it as an example. Sites that bind a session to its IP or device (Google, LinkedIn, GitHub) drop copied sessions, so sign in to those inside the remote browser instead.

## Where the security checks live

- **The public `/mcp` route for Events.** Caddy answers 403 to any address outside OpenAI's connector egress list (`scripts/openai-allowlist.sh`, refreshed weekly by `deploy/systemd/openai-allowlist.timer`), and the MCP still requires an issuer-signed token. The issuer's sign-in is one long random password: keep it in a password manager, not in a file on the server.
- **The VPS's sshd.** Port 22 answers only on loopback and `tailscale0` (`scripts/ssh-tailnet-only.sh`, run by `deploy/systemd/ssh-tailnet-only.service`). On the open internet, scanners filled sshd's `MaxStartups` and it dropped new connections at random, including the MCP server's own to the VPS gateway, so ChatGPT saw timeouts. Reach the VPS over the tailnet, and keep the provider's web console as the way in when Tailscale is down.
- **Each gateway.** It hides every pane and agent whose `cwd` or `foreground_cwd` is outside `allowedRoots` and reports them as "not found". A tab or workspace counts as in scope when it holds an in-scope pane, and closing one needs all of its panes in scope.
  - File paths are resolved through symlinks before the root check, so a link inside a root cannot point the tools outside it.
  - Targets must match `^[A-Za-z0-9][A-Za-z0-9_:.-]{0,63}$`, so a flag-shaped value never reaches Herdr.
  - Repo tasks send only the command written in `gateway.json`. `git`, `rg` and the document converter run with fixed argument lists, never through a shell.
  - The audit log (`~/.local/state/herdr-chatgpt/audit.jsonl`) records every op with its target, paths and command text.
- **authorized_keys.** Mac: `from="<OVH tailnet IP>",restrict,command="…/herdr-gateway-launcher.sh"`. OVH: the same with `from="127.0.0.1"`. The launcher ignores `SSH_ORIGINAL_COMMAND`.
- **ssh on OVH.** It runs with `-F /dev/null`, a pinned `UserKnownHostsFile`, `StrictHostKeyChecking=yes`, and no agent or port forwarding.
- **systemd on OVH.** The base MCP unit permits loopback and the tailnet with `IPAddressDeny=any`, and runs as `herdr-mcp` with `ProtectSystem=strict`. Events needs a reviewed drop-in for the configured callback hosts' public IP addresses. [The generator and its limits](docs/mcp-events.md#callback-network-policy) retain the deny rule and avoid an unrestricted internet allowance.

The Mac runs ordinary macOS OpenSSH on tailnet port 22. Tailscale SSH is off (`RunSSH: false`), so sshd enforces the forced command.

On macOS, `~/Downloads`, `~/Documents` and `~/Desktop` are privacy-protected. A gateway started by sshd can only read them when "Allow full disk access for remote users" is on (System Settings > General > Sharing > Remote Login).

## Notifications and offline machines

Each gateway keeps a watch list (`watch.json` in its state directory) with two kinds of entry:

- **Turn:** `prompt_agent` watches the turn it started when the call returns before the agent settles. The entry goes once that turn is reported.
- **Managed:** `watch_agent`, and `start_agent` and `spawn_agent` unless `watch: false`, watch every turn until the agent exits or `watch_agent` gets `stop: true`. This covers agents started outside WorkDone, like a `cursor-agent` typed into a pane, and turns started by someone at the Mac or by another agent.

The MCP server on OVH keeps one `watch_poll` loop per machine with watched agents. Each call waits up to 20 s for Herdr events; failed or early empty calls wait the configured interval, 15 s by default. It sends phone messages through the gateway named in `notify.machine` in `/etc/herdr-mcp/ovh.json`, which runs its `notifyCommand`. On OVH that is the notify skill's `notify.sh send -k phone`, which goes through the apprise container to Pushover.

The same Herdr reports also feed native ChatGPT Events when authenticated subscriptions are configured. This changes the ChatGPT wake path only. Phone notifications and gateway watches continue separately; a webhook callback does not replace them. None of these is the record of what is owed: `work.json` and `inbox.json` are, and `owed_work` reads them.

Events fire on edges, so an agent that stays idle or blocked is reported once:

- **finished:** it was seen working, or was prompted, and has settled. A turn shorter than the poll interval also counts: Herdr's `state_change_seq` moves on every status change, so `done` with a new seq, `idle` with a new seq after `idle`, or `done` after anything else means a turn ran between two polls. `done` to `idle` alone is someone looking at the pane and is not reported.
- **asks:** a finished turn whose last reply ends by asking the owner something.
- **waiting for an answer:** Herdr shows the agent blocked at a question, or at a menu WorkDone does not recognise. Go-ahead menus are answered instead and not sent (see Tools).
- **gone:** the pane closed, the agent exited, or it left the allowed roots.
- **browser run ended:** `done` with the step count and final URL, `blocked at goal N`, `failed to start` with the last log line (exit 2: no Chrome, missing keys), `stopped`, or `ended without a result` when the process died without writing an exit code. Each run is reported once, and a machine with a run still going stays on the notifier's poll list.

Messages name the machine, the agent (its name, or kind, terminal title and pane ID) and its folder, and add a one-line excerpt of at most about 200 characters. For finished turns that is the start of the answer from the Claude or Cursor transcript, for questions the question, and for dialogs the lines around the dialog's question. Agents without a transcript fall back to the bottom of the screen. Values that look like credentials (API keys, bearer tokens, `password=`, runs of 32 or more letters and digits) are replaced with `[redacted]` before a message leaves the machine; that is a pattern match, not a guarantee. The watch entry keeps the last event, which `get_agent` and `overview` return as `watch.last_event`.

A machine that fails to connect (ssh exit 255 with a connection error) is marked offline for 60 s. Calls to it return `machine_offline` at once, listings that ask every machine don't wait for it, and a sleeping Mac only delays its own notifications.

`gateway/watcher.ts` also runs on its own, as a launchd agent (`scripts/install-watcher.sh`), for a setup with a single machine. Don't run it next to the MCP notifier: both would work through the same watch list.

## WorkDone in Herdr's sidebar

The gateway reports two display-only tokens on agent panes with `pane.report_metadata` (source `workdone`): `$workdone` is `watched` while WorkDone reports every turn of the agent and goes when the watch ends, and `$workdone_note` says what just happened: `approved permission: Yes` for a minute after an auto-approval, `done` for ten minutes after `prunable_agents` lists the agent as done. A prompt clears the note. They are two keys because a token's TTL clears it instead of bringing back the value before. Herdr forgets tokens on a restart, and the watch state files stay the source of truth. A report is never awaited and a failed one is ignored.

Herdr only shows them once a sidebar row names them. In `~/.config/herdr/config.toml`, starting from the default Agent rows:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent", "$workdone", "$workdone_note"],
]
```

A token nobody reported disappears with its separator. A `rows_by_agent` override replaces `rows`, so add the tokens there too if you have one.

## Differences from the runbook

- Bun replaces Node. The gateway is `gateway/*.ts`, run by `bun --no-env-file --no-install`, and OVH uses `/usr/local/bin/bun` (the installer writes it to `bun-path` next to the launcher).
- The gateway calls the Herdr socket API instead of the `herdr` binary, so its config has `herdrSocketPath` and no `herdrPath`.
- The MCP server uses the v2 SDK (`@modelcontextprotocol/server`) and serves 2026-07-28 plus the older stateless JSON transport. Native MCP Events requires 2026-07-28. Earlier logs showed discovery without subscriptions while Events was only advertised and refused; that history does not establish current ChatGPT availability. The implementation now supplies webhook subscription methods when `auth` and `events` are configured. Rescan WorkDone after changing tools or events, then test in a new chat. See [MCP Events](docs/mcp-events.md).
- The existing tunnel setup script uses `--sample sample_mcp_remote_no_auth`, and the deployed app was configured as No Auth. That remains the legacy fallback setup. Native Events requires a real OAuth principal on the same `/mcp` endpoint as tools. `auth.listenPort` stages authenticated tools and Events on a second loopback port in the same MCP process, preserving the old listener/card and using one shared notifier. [Secure MCP Tunnel supports OAuth discovery](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#oauth), but an authorization server, JWKS, account grants and separate authenticated plugin connection still have to be configured and checked before cutover.

## Development

```bash
bun install && (cd mcp && bun install)   # also points git at .githooks (pre-commit runs bun run check)
bun run check                        # tsc + all tests
scripts/install-gateway.sh           # BUN=/usr/local/bin/bun on OVH
scripts/install-watcher.sh           # Mac only
scripts/deploy-ovh.sh                # from the Mac: OVH gateway, its key, MCP server, restart
scripts/add-machine.sh NAME ALIAS '~/dir' ...   # from the Mac: any machine with Bun and a Herdr server
printf '%s\n' '{"id":"1","op":"bridge_status","params":{}}' | ~/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh
```

## License

MIT. See [LICENSE](LICENSE).
