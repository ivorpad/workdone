# Host-specific notes

What differs by where the machine lives. Each section lists only the differences from SKILL.md.

- [instabox](#instabox)
- [Plain Linux VPS or cloud VM](#plain-linux-vps-or-cloud-vm)
- [macOS](#macos)
- [Namespace devbox (macOS VM)](#namespace-devbox-macos-vm)
- [NAS (Synology and similar)](#nas-synology-and-similar)
- [Claude in Chrome](#claude-in-chrome)

## instabox

Use the `instabox` skill for the CLI. Facts that matter here:

- First shell: `instabox ssh BOX` (no time limit) or `instabox exec BOX -- CMD` (60 s default, 600 s max, stdin capped at 1 MB). User `dev`, passwordless sudo, HOME `/data/home`, work root `/data/workspace`. sshd already listens on 22, `/dev/net/tun` exists, linger is on. No tmux.
- `instabox create --name NAME` for a new box; 5 boxes per account (`instabox usage`). The server's default template was `agent-browser` (universal plus a desktop) on 2026-10-15, which works the same here. The `herdr` template exists, but the universal one plus the copied binary matches OVH's version exactly.
- Secrets go in the Vault once for every box: `GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `.gitconfig`, global gitignore (the `instabox-basic-setup` skill; `instabox vault set NAME` reads stdin). The Vault writes `/run/instabox/vault/env`, sourced only by login shells; the Herdr unit in `linux-prep.sh` waits for it and starts from a login shell. After a Vault change: `instabox vault push BOX`, then restart Herdr. A new box may get nothing at create (`vault show` said "Last write: none yet" on four new boxes): run `instabox vault push BOX` before the prep script, or restart Herdr after it. Several boxes at once: the Codex device logins after the first need no passkey while Chrome stays signed in to OpenAI, and the code page has nine single-character boxes, so type one character per box.
- Pausing: a box pauses after 30 idle minutes and tailnet traffic does not wake it, so ChatGPT gets `machine_offline`. `instabox resume BOX` from the Mac (or anywhere with an API key) wakes it. For ChatGPT to wake it, add `machines.NAME.wake = {via, box}` to `ovh.json` after `add-machine.sh` and restart `herdr-mcp` (DEPLOYMENT.md, "Machines that pause"; the key holder is in `.context/machines.md`). Then `wake_machine` resumes it. `--auto-suspend 0` keeps it on; ask the user, it may cost. On CLI `0d3a224` (2026-10-15), `instabox auto-suspend BOX VALUE` on an existing box changed nothing for any value (0, 2h, 720h): it printed "auto-pause after 30m idle" and the box's `revision` stayed 1. Check `instabox get BOX --json | jq .autoSuspendAfterSeconds` after setting it, and pass `--auto-suspend` at create instead (untested). A stop ends every process; the Herdr unit brings the server back, but agents in it are gone.
- Anything written into a box is readable by that instabox account. Boxes for other people get `--no-vault`.
- Cloning: `instabox snapshot save`, then `instabox create --snapshot`; do the identity cleanup in SKILL.md first.

## Plain Linux VPS or cloud VM

- Providers often give root only. Create the agent user, give it passwordless sudo (`add-machine.sh` and the prep script run sudo without a terminal), copy root's authorized key to it, and work as that user.
- A provider firewall may block nothing on the tailnet, but sshd on the public IP is still exposed. After the tailnet works, the user may want port 22 closed publicly (`scripts/ssh-tailnet-only.sh` exists for that). That is their decision.
- Debian/Ubuntu: `apt-get install -y openssh-server curl jq git` if missing. ARM hosts need an arm64 Herdr binary: OVH's is x86_64. Get one from another arm64 machine or herdr.dev's installer, then pin the version (`herdr update` only works once Herdr is installed).

## macOS

- Remote Login must be on (System Settings > General > Sharing > Remote Login). A human turns it on. `launchctl` showing sshd "not running" is normal.
- Herdr from Homebrew at the same version; keep it running with a LaunchAgent (`brew services start herdr` is untested here; check it survives a reboot). A brew upgrade cannot hand off a running server: restarting it kills its panes, so that is the owner's call.
- The gateway runs under sshd, which has no Screen Recording and no keychain. Set `"execInPane": true` in `gateway.json` so `exec` runs inside a Herdr pane (the user's shell, keychain, ssh-agent). Screenshots work only if the Herdr server descends from a terminal app that has Screen Recording (Ghostty on the main Mac).
- Reading `~/Downloads`, `~/Documents` or `~/Desktop` needs "Allow full disk access for remote users" in the Remote Login panel; it applies to every SSH session.
- Claude Code on macOS keeps its login in the keychain; for panes started over SSH, the `CLAUDE_CODE_OAUTH_TOKEN` approach is more reliable.

## Namespace devbox (macOS VM)

- One devbox per user, so reuse the existing one when asked for "a Namespace box". `devbox` CLI is at `~/.local/bin`; a `devbox login` session has expired right after approval once, so log out and in again.
- The devbox's own vmguest holds `10.0.0.2:22`; Remote Login must be turned on by hand for the tailnet sshd.
- Unverified: whether the Herdr LaunchAgent comes back after the VM stops and starts. Check after the first restart.

## NAS (Synology and similar)

- `scp` may fail; copy with `ssh ALIAS 'cat > path' < file`.
- No systemd user units: start Herdr with `setsid nohup herdr server >~/.local/state/herdr-server.log 2>&1 &` and add a boot task in the NAS's task scheduler.
- Herdr started with a minimal PATH leaves panes without `claude` or `codex`. In `~/.config/herdr/config.toml` set `[terminal] default_shell = "/path/to/shell"` and `shell_mode = "login"`, then `herdr server reload-config`.

## Claude in Chrome

The Claude desktop app rewrites `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_browser_extension.json` so it claims the extension Claude Code uses, and the browser tools report "not connected". To recover:

1. Move that manifest into `~/.claude/chrome/disabled/` with a timestamp suffix, and kill any `/Applications/Claude.app/.../chrome-native-host` process.
2. Quit Chrome. AppleScript `quit` closes the windows but can leave the main process running with no windows; `kill -TERM` it (its tabs are saved).
3. Start it with `open -n -a "Google Chrome" --args --restore-last-session --profile-directory="<PROFILE>"` (the profile is in `.context/machines.md`). Plain `open -a` may only bring forward a leftover automation Chrome (`--remote-debugging-port=0`) instead of starting the user's.
4. `list_connected_browsers` should show the Mac, and `claude --chrome-native-host` should be running.

Other browser routes do not help here: the codex computer-use tool refuses from Claude Code ("Missing required Codex turn metadata"), and computer use can be held by another Claude session and only reads browsers anyway. Restarting the user's Chrome closes their tabs for a moment. Say so first unless they already asked for Claude in Chrome to be fixed.
