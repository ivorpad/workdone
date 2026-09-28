# Herdr ChatGPT bridge

```text
ChatGPT → OpenAI Secure MCP Tunnel → MCP server on OVH (127.0.0.1:8787)
       → OpenSSH over Tailscale → forced-command gateway on the Mac   → Herdr socket, files, shell
       → OpenSSH to 127.0.0.1   → forced-command gateway on OVH (debian) → same
```

The runbook this implements is `docs/INSTALL_AND_SETUP.md`. Everything runs on Bun.

The full record of the actual deployment (tunnel, API keys, ChatGPT app, plugin, every failure and how it was fixed) is in Spanish in `docs/DESPLIEGUE.md`.

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

Every tool takes an optional `machine` (`mac`, `ovh`, and whatever `scripts/add-machine.sh` added). It is a plain string, not an enum, so ChatGPT's cached tool list does not need a refresh when a machine is added. Listing tools called without one (`bridge_status`, `overview`, `list_agents`, `list_panes`, `list_workspaces`, `list_repos`) ask every machine and key the answer by machine name. Pane, tab and workspace IDs only mean something on the machine that issued them.

- **Agents:** `overview` (every agent with status, git branch, the start of its last reply, the dialog if blocked), `list_agents`, `get_agent`, `read_agent` (`source: reply` reads the last answer from the Claude or Cursor transcript instead of the screen), `prompt_agent` (with `wait`, returns the reply), `wait_agent`, `watch_agent`, `send_agent_keys`, `spawn_agent` (place, start, wait, first prompt in one call), `start_agent`. Kinds come from `agentKinds`; `cursor` is `cursor-agent`, and without an `agentKinds` list a gateway offers it where `cursor-agent` is installed.
- **Menus and steering:** `answer_agent` answers the menu an agent shows (approval, question, folder trust, update notice) by option number, plus `text` for an option that opens a field, and `options` for a multi-select. `gateway/dialog.ts` reads the menu off the screen and knows each CLI's keys: Claude Code and Codex take the digit (Claude's folder trust has no numbers, so arrows and enter), Cursor the key in parentheses or the letter in brackets, and a multi-select flips boxes with digits then tabs to its review step. `steer_agent` types a message into a working agent: Claude Code and Codex queue it until the current tool call ends, and Cursor gets a second enter so it goes in at once. It refuses while a menu is up, since its enter would answer the menu, and prompts an idle agent instead. `get_agent`, `read_agent` and `overview` return the parsed menu as `choices`. Codex's folder trust, update and model notices, which Herdr reads as idle, count as `attention: dialog` too, and `prompt_agent` refuses to type into any of them. Keys go one at a time with a pause, and text apart from its enter: in one burst the CLIs dropped keys or took the enter before the text. The screens this was built from are in `tests/fixtures/screens`.
- **Agent aliases:** ChatGPT starts agents by names, never by CLI or model; the list is in [Agents](#agents). With `agentAliases` in a gateway config, each name fixes the Herdr kind, the model and the efforts on offer. `bridge_status` lists the names as `agent_kinds` and their efforts under `agents`, and `spawn_agent`/`start_agent` take `kind` and `effort`. Replies show the name an agent was started as (agents started another way get the first name of their kind, or `agent`), and vendor and model names in agent text, titles and errors are replaced with it. The words come from `redact` (default list in `gateway/mask.ts`, matched case-sensitively, so a plain "cursor" in prose is kept). File and shell ops (`read_file`, `exec` and the rest) return content unchanged, and so do ID and path fields. The scrub works on words, so an agent that describes itself in some other way can still give itself away. The file tools refuse the gateway's config directory, its state directory and the alias file even inside an allowed root. `exec` is a shell, though: with it on, ChatGPT can `cat` the alias file or read `ps`, so the names keep model names out of what the agent tools return but are not a secret from a caller with exec.
- **Attention:** `overview`, `get_agent` and `read_agent` add `attention` to Herdr's status: `dialog` (an approval or question dialog, including Cursor's workspace trust prompt, which Herdr reads as idle) or `question` (the agent stopped and the end of its last reply asks the owner something). `watch` shows whether the agent is watched and the last notification sent about it.
- **Layout:** `list_workspaces`, `list_panes`, `read_pane`, `split_pane`, `create_workspace`, `create_tab`, `rename`, `focus`, `move_pane`, `close`, `send_pane_input`.
- **Repos:** `list_repos`, `run_repo_task`, `list_worktrees`, `create_worktree`, `remove_worktree`.
- **Browser:** `browse` starts a Jev browser run (`jev-browser run URL GOAL...`) in OVH's persistent signed-in Chromium and returns a run id at once; the run is detached from the ssh call, so it outlives it. `browse_status` gives a run's state (`running`, `done`, `blocked`, `failed`, `stopped`, `lost`), the JSON summary with each goal's status and final URL, the end of the step log and `final_pages` (each goal's last URL, title and the start of its visible text: 800 characters by default, `text_chars` up to 6000; read from the trace, since the file tools do not serve the gateway's state), or the last 10 runs. `browse_stop` kills the run's process group. Runs live in `<stateDir>/jobs/<id>/` (`job.json`, `log.txt`, `summary.json`, `trace.json`, `exit`); the newest 50 are kept. A gateway offers it with `"browser": {"command": ["~/.local/bin/jev-browser", "run"], "cwd": "~/src/jev-browser"}` (the cwd holds jev-browser's `.env`) and `allowExec` on. Browser results are not masked, so URLs stay usable.
- **exec in your own session:** with `"execInPane": true` in a gateway config (the Mac and OVH), `exec` runs the command the way you would after `ssh` and a new Herdr pane: in a tab of a `workdone exec` workspace, in your interactive zsh, so `.zshrc` (aliases, functions, PATH), the keychain (`gh`'s token on the Mac) and your ssh-agent are there. The command runs in a subshell of that shell, sourced from a file, with stdin, stdout and stderr through files; the gateway waits for its exit code, reads the output and closes the tab. The workspace stays, so you can watch commands appear. It costs about a second a call (a new tab and shell). A timeout sends ctrl+c. Without the switch (syno), `exec` runs as the gateway's own ssh login (`zsh -lc`, no keychain, no `.zshrc`): on the Mac that is why `gh` failed with 401 from ChatGPT while it worked in the Robin panes. The result has `via: "pane"` when it ran in a pane.
- **Host:** `exec` (shell command, returns exit code and output), `run_command_in_pane`, `list_dir`, `read_file` (text; PDF and Office files as Markdown through `documentConverter`; images as MCP image content), `write_file`, `move_path`, `delete_path` (moves into `~/.local/state/herdr-chatgpt/trash`), `search_files` (ripgrep).

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

## Agents

The same 37 names on the Mac, OVH and syno. Birds run in Claude Code, trees and fruit in Codex, other animals in Cursor. Say a name and, if you like, an effort ("panda on extra high"); without one the agent uses its default. Dictated names and efforts are matched loosely: "Extra High" is `xhigh`, "maximum" is `max`.

**Claude Code.** Claude models run only here, pinned by full model ID. Efforts: low, medium, high, xhigh, max.

| Name | Model | Default |
|---|---|---|
| eagle | Claude Fable 5.1 (`claude-fable-5-1`) | high |
| robin | Claude Opus 5.5 (`claude-opus-5-5`) | high |
| falcon | Claude Sonnet 5.5 (`claude-sonnet-5-5`) | max |

**Codex.** Efforts: low, medium, high, xhigh, max, and ultra where marked.

| Name | Model | Default | Efforts |
|---|---|---|---|
| maple | GPT-6 Astra | medium | low … max, ultra |
| willow | GPT-6 Sol | low | low … max, ultra |
| cedar | GPT-6 Luna | medium | low … max |
| cherry | GPT Reserve | medium | low … max |
| olive | GPT-5.6 Sol | low | low … max, ultra |
| apple | GPT-5.6 Terra | medium | low … max, ultra |
| lemon | GPT-5.6 Luna | medium | low … max |
| mango | GPT-5.5 | medium | low … xhigh |

**Cursor.** Started with `--force --trust`: no approval or folder trust prompts. "fast" means each effort also has a `-fast` form (`high-fast`, `xhigh-fast`, …).

| Name | Model | Default | Efforts |
|---|---|---|---|
| zebra | GPT-5.6 Sol | high | none, low, medium, high, xhigh, max; fast |
| turtle | GPT-5.6 Terra | high | none, low, medium, high, xhigh, max; fast |
| giraffe | GPT-5.6 Luna | high | none, low, medium, high, xhigh, max; fast |
| lobster | GPT-5.5 | high | none, low, medium, high, xhigh; fast |
| badger | GPT-5.4 | high | low, medium, high, xhigh; fast |
| salmon | GPT-5.4 mini | high | none, low, medium, high, xhigh |
| shark | GPT-5.4 nano | high | none, low, medium, high, xhigh |
| hippo | GPT-5.3 Codex | high | low, default, high, xhigh; fast |
| rhino | GPT-5.2 | high | low, default, high, xhigh; fast |
| frog | GPT-5.1 | high | low, default, high |
| kitten | GPT-5 mini | default | default |
| panda | Grok 4.7 | xhigh-fast | low, medium, high, xhigh; fast |
| pony | Grok 4.6 | high | low, medium, high, xhigh; fast |
| jaguar | Grok 4.5 | high | low, medium, high; fast |
| rabbit | Gemini 3.8 Flash | high | low, medium, high |
| llama | Gemini 3.7 Flash | high | low, medium, high |
| lizard | Gemini 3.6 Flash | high | minimal, low, medium, high |
| goat | Gemini 3.5 Flash | default | default |
| wolf | Gemini 3 Flash | default | default |
| gecko | Gemini 3.1 Pro | default | default |
| monkey | Composer 2.5 | default | default; fast |
| camel | Kimi K3 | high | low, high, max |
| moose | Kimi K2.7 Code | default | default |
| dolphin | GLM 5.2 | high | high, max |
| kangaroo | Muse Spark 1.3 | high | minimal, low, medium, high, xhigh, max |
| gorilla | Cursor "auto" (Cursor picks) | default | default |

**Where the list comes from.** `bun scripts/agent-aliases.ts` writes it to `~/.config/herdr-chatgpt/agent-aliases.json` and prints it; gateway configs point there with `"agentAliases": "~/.config/herdr-chatgpt/agent-aliases.json"`, and each machine offers only the names of the CLIs it has. Claude Code's three are fixed in `CLAUDE_CODE`; the rest come from `codex debug models` and `cursor-agent models`, leaving Cursor's Claude models out. Rerun it when a CLI adds models: existing names stay, a model a CLI stops offering loses its name, and a CLI missing on the machine keeps its old ones. Then copy the file to the other machines so the names match; the gateways read it on every call. `DEFAULT_EFFORT` in the script holds defaults you chose (panda: `xhigh-fast`), and `RETIRED` holds names that are never handed out again: parrot (Haiku) and the 23 that were Claude models in Cursor, tiger, lion and koala among them. The table above is a copy of the map on 28-09; the file is the source of truth.

An alias can also be written inline in a gateway config: `"wren": {"kind": "claude", "args": ["--model", "claude-opus-5-5", "--effort", "{effort}"], "efforts": ["low", "medium", "high", "xhigh", "max"], "effort": "high"}`. `efforts` maps each effort ChatGPT may pass to what replaces `{effort}` in `args`, which for Cursor is the whole model ID.

## The browser on OVH and its viewer

`browse` drives one persistent Chromium on OVH: the Portainer stack `agent-computer` (id 32), whose files live in `~/src/tries/2026-08-19-agent-computer/deploy/ovh/` (`stack.yml`, and a README with the build and update steps). Its profile is the Docker volume `agent-computer-ovh-config`, so logins survive restarts and redeploys; removing that volume signs every site out.

What reaches it, since 28-09:

| Who | Where | Check |
|---|---|---|
| You, from a device on your tailnet | https://ovh-vps.your-tailnet.ts.net | being on the tailnet; no password |
| WorkDone (`browse`, the MCP server, `exec`) | CDP `127.0.0.1:9223`, control `127.0.0.1:9224` on OVH | bearer from `ovh:~/.config/agent-computer/ovh.env` |
| jev-browser on OVH | relay `127.0.0.1:9230`, which adds the bearer | local only |

- **Tailnet only.** The stack publishes the viewer on OVH's loopback (`127.0.0.1:3000`), and `tailscale serve` puts it on the tailnet with Tailscale's HTTPS certificate: `ssh ovh 'sudo tailscale serve --bg --https=443 http://127.0.0.1:3000'`, checked with `tailscale serve status`, removed with `tailscale serve --https=443 off`. Never use `tailscale funnel` for it: that makes it public.
- **No Cloudflare.** It used to be `headless.example.dev` through cloudflared and Cloudflare Access. That hostname, its tunnel route and its Access app are gone; the name now falls through to the `*.example.dev` wildcard, which serves a Cloudflare error.
- **No password.** The viewer had Basic auth (user `agent`) behind Access. With the tailnet as the gate it was only a second prompt, so the stack no longer sets `PASSWORD`. The old password is still in `ovh.env`, unused.
- **Off the `edge` network.** The browser container sits on the stack's own network, so no other container on OVH (cloudflared, the public stacks) can reach the viewer or CDP. Everything above goes through the loopback ports.
- **Clipboard.** On (`SELKIES_CLIPBOARD_ENABLED: "true"`), so you can paste into it, e.g. a password from your manager. Allow the clipboard prompt the first time you paste. If paste still does nothing, the viewer page kept an old setting in your browser's local storage (`…/_clipboard_enabled` = `false`, saved while the server had it off): clear the site data for `ovh-vps.your-tailnet.ts.net`, or remove those `_clipboard` keys, and reload. The viewer's sidebar has a clipboard box as a fallback; the remote browser runs on Linux, so paste inside it with Ctrl+V.

Changing the stack: edit `stack.yml` in the agent-computer repo and update stack 32 through Portainer's API with the stack's existing `Env` array, as its deploy README shows; the on-box portainer script sends an empty env and drops the secrets. Each update recreates the container: reload the viewer afterwards.

## Signed-in sites for `browse` on OVH

`browse` runs in the persistent Chromium on OVH, the one you watch at https://ovh-vps.your-tailnet.ts.net (tailnet only). It only knows the logins its own profile holds, and it keeps them across restarts and while the Mac sleeps. There are two ways to give it one.

**Copy a login from the Mac.** From this Mac, with Chrome's `Profile 2` holding the login:

```sh
cd ~/src/tries/2026-08-19-agent-computer/deploy/ovh
python3 ovh_session.py import --domains github.com \
  --verify-url https://github.com/settings/profile --expect "Public profile" --reject url:/login
```

It copies that domain's cookies and local storage into OVH's profile, opens `--verify-url` there, and prints a verdict: `signed-in` when the `--expect` text shows and no `--reject` URL was hit. `--domains` takes a comma-separated list. The captured file is deleted afterwards. Check again any time without copying:

```sh
python3 ovh_session.py verify --url https://github.com/settings/profile --expect "Public profile" --reject url:/login
```

**Copy every signed-in site at once.** `scripts/export-browser-sessions.py` lists the sites Chrome's `Profile 2` is signed in to (`chrome-canary-cdp sites`), turns them into domains and leaves out the ones an agent should never reach: banks, brokers and payments, AWS (so `amazon.com`, whose cookies include the AWS console's), government ID and tax sites, work's corporate sign-ins, and the OVH account that owns the server. The list is `EXCLUDE` in the script.

```sh
scripts/export-browser-sessions.py            # print the domains it would copy
scripts/export-browser-sessions.py --run      # copy them to OVH
scripts/export-browser-sessions.py --run --only linkedin.com,github.com
```

Google and YouTube do not survive a copy: Chrome ties Google's session cookies to the Mac, so on OVH they land signed out. Sign in to Google on OVH itself.

**Sign in on OVH itself.** Open https://ovh-vps.your-tailnet.ts.net from a device on your tailnet (no password: being on the tailnet is the access check) and log in there like on any computer. Use this for sites that tie a session to the IP or device it was made on. On 28-09: an imported LinkedIn session verified as signed in and LinkedIn revoked it about a minute later (the feed redirected to `/uas/login`); a second export, after the Mac signed in again, held. An imported GitHub session verified, then was signed out about 10 minutes later. Google never works as a copy. Once a copy is revoked its cookies are dead, so do not import the same ones again. A login made on OVH belongs to OVH's IP and lasts.

**See what the browser has open**, without the viewer. CDP is on OVH's loopback and wants the bearer token from `ovh.env`:

```sh
ssh ovh 'set -a; . ~/.config/agent-computer/ovh.env; set +a
  H="Authorization: Bearer $AGENT_COMPUTER_API_TOKEN"
  curl -s -H "$H" http://127.0.0.1:9223/json/list | jq -c ".[] | select(.type==\"page\") | {title, url}"
  curl -s -H "$H" -X PUT "http://127.0.0.1:9223/json/new?https://www.linkedin.com/feed/"'
```

Every site this browser is signed in to is a site ChatGPT can act on as you through `browse`, around the clock. Add the ones you want it to use, not the whole profile, and when a login expires, sign in again the same way.

## Where the security checks live

- **Each gateway.** It hides every pane and agent whose `cwd` or `foreground_cwd` is outside `allowedRoots` and reports them as "not found". A tab or workspace counts as in scope when it holds an in-scope pane, and closing one needs all of its panes in scope.
  - File paths are resolved through symlinks before the root check, so a link inside a root cannot point the tools outside it.
  - Targets must match `^[A-Za-z0-9][A-Za-z0-9_:.-]{0,63}$`, so a flag-shaped value never reaches Herdr.
  - Repo tasks send only the command written in `gateway.json`. `git`, `rg` and the document converter run with fixed argument lists, never through a shell.
  - The audit log (`~/.local/state/herdr-chatgpt/audit.jsonl`) records every op with its target, paths and command text.
- **authorized_keys.** Mac: `from="<OVH tailnet IP>",restrict,command="…/herdr-gateway-launcher.sh"`. OVH: the same with `from="127.0.0.1"`. The launcher ignores `SSH_ORIGINAL_COMMAND`.
- **ssh on OVH.** It runs with `-F /dev/null`, a pinned `UserKnownHostsFile`, `StrictHostKeyChecking=yes`, and no agent or port forwarding.
- **systemd on OVH.** The MCP unit can only reach loopback and the tailnet (`IPAddressAllow`), and runs as `herdr-mcp` with `ProtectSystem=strict`.

The Mac runs ordinary macOS OpenSSH on tailnet port 22. Tailscale SSH is off (`RunSSH: false`), so sshd enforces the forced command.

On macOS, `~/Downloads`, `~/Documents` and `~/Desktop` are privacy-protected. A gateway started by sshd can only read them when "Allow full disk access for remote users" is on (System Settings > General > Sharing > Remote Login).

## Notifications and offline machines

Each gateway keeps a watch list (`watch.json` in its state directory) with two kinds of entry:

- **Turn:** `prompt_agent` watches the turn it started when the call returns before the agent settles. The entry goes once that turn is reported.
- **Managed:** `watch_agent`, and `start_agent` and `spawn_agent` unless `watch: false`, watch every turn until the agent exits or `watch_agent` gets `stop: true`. This covers agents started outside WorkDone, like a `cursor-agent` typed into a pane, and turns started by someone at the Mac or by another agent.

The MCP server on OVH polls the machines with watched agents (`watch_poll`, every 15 s) and sends each message through the gateway named in `notify.machine` in `/etc/herdr-mcp/ovh.json`, which runs its `notifyCommand`. On OVH that is the notify skill's `notify.sh send -k phone`, which goes through the apprise container to Pushover.

Events fire on edges, so an agent that stays idle or blocked is reported once:

- **finished:** it was seen working, or was prompted, and has settled. A turn shorter than the poll interval also counts: Herdr's `state_change_seq` moves on every status change, so `done` with a new seq, `idle` with a new seq after `idle`, or `done` after anything else means a turn ran between two polls. `done` to `idle` alone is someone looking at the pane and is not reported.
- **asks:** a finished turn whose last reply ends by asking the owner something.
- **waiting for an answer:** Herdr shows the agent blocked at a dialog.
- **gone:** the pane closed, the agent exited, or it left the allowed roots.
- **browser run ended:** `done` with the step count and final URL, `blocked at goal N`, `failed to start` with the last log line (exit 2: no Chrome, missing keys), `stopped`, or `ended without a result` when the process died without writing an exit code. Each run is reported once, and a machine with a run still going stays on the notifier's poll list.

Messages name the machine, the agent (its name, or kind, terminal title and pane ID) and its folder, and add a one-line excerpt of at most about 200 characters. For finished turns that is the start of the answer from the Claude or Cursor transcript, for questions the question, and for dialogs the lines around the dialog's question. Agents without a transcript fall back to the bottom of the screen. Values that look like credentials (API keys, bearer tokens, `password=`, runs of 32 or more letters and digits) are replaced with `[redacted]` before a message leaves the machine; that is a pattern match, not a guarantee. The watch entry keeps the last event, which `get_agent` and `overview` return as `watch.last_event`.

A machine that fails to connect (ssh exit 255 with a connection error) is marked offline for 60 s. Calls to it return `machine_offline` at once, listings that ask every machine don't wait for it, and a sleeping Mac only delays its own notifications.

`gateway/watcher.ts` also runs on its own, as a launchd agent (`scripts/install-watcher.sh`), for a setup with a single machine. Don't run it next to the MCP notifier: both would work through the same watch list.

## Differences from the runbook

- Bun replaces Node. The gateway is `gateway/*.ts`, run by `bun --no-env-file --no-install`, and OVH uses `/usr/local/bin/bun` (the installer writes it to `bun-path` next to the launcher).
- The gateway calls the Herdr socket API instead of the `herdr` binary, so its config has `herdrSocketPath` and no `herdrPath`.
- The tunnel profile uses `--sample sample_mcp_remote_no_auth`. Per the tunnel-client docs, that is the sample for a local HTTP MCP server without OAuth. `sample_mcp_stdio_local` is for stdio servers.

## Development

```bash
bun install && (cd mcp && bun install)
bun run check                        # tsc + all tests
scripts/install-gateway.sh           # BUN=/usr/local/bin/bun on OVH
scripts/install-watcher.sh           # Mac only
scripts/deploy-ovh.sh                # from the Mac: OVH gateway, its key, MCP server, restart
scripts/add-machine.sh NAME ALIAS '~/dir' ...   # from the Mac: any machine with Bun and a Herdr server
printf '%s\n' '{"id":"1","op":"bridge_status","params":{}}' | ~/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh
```
