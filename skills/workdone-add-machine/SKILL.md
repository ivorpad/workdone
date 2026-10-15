---
name: workdone-add-machine
description: Add a new machine to WorkDone so ChatGPT can run Claude Code and Codex agents on it, wherever the machine lives (an instabox box, a VPS, a cloud VM, a Namespace devbox, a NAS, another Mac). Covers getting a shell on it, Tailscale, sshd, Bun, Herdr as a service, agent sign-ins without printing secrets, add-machine.sh from a clean release worktree, capabilities, a real spawn test through OVH, and adding it to the Mac's Herdr. Use whenever the user wants a new box, machine, server, devbox or "another place for agents" in WorkDone, or says "set it up for workdone", "add this machine", "make the other instabox boxes work like ib1", "add my VPS to herdr", even if they only name one step.
---

# Add a WorkDone machine

A WorkDone machine is any computer where the MCP server on OVH can reach, over the tailnet, an ordinary sshd that forces a WorkDone gateway, which talks to a running Herdr server whose panes have signed-in agent CLIs. Every step below exists because skipping it was a real failure once. The order matters: `add-machine.sh` refuses to run until Bun and Herdr are there, and an agent smoke test only means something once the CLIs are signed in.

The repo is public. Real hosts, IPs, account names and the current machine list are in `.context/machines.md` (gitignored). Read it first, and add the new machine to it at the end. Background lives in `docs/DEPLOYMENT.md` sections 2 and 15 (Phase 13), and 16 (capabilities, agent models).

Host-specific notes (instabox, macOS, NAS, Namespace devbox, plain VPS) are in `references/hosts.md`. Read the section for the kind of machine before step 2.

## 0. Settle the inputs with the user

Ask only what you cannot derive:

- **Where it lives and how you get a first shell**: `instabox ssh BOX`, `ssh root@IP` from a provider, a devbox CLI, an existing ssh alias. Without a first shell nothing else works.
- **NAME** for WorkDone: matches `^[a-z][a-z0-9-]{0,15}$`. It shows in `bridge_status` and every tool call. Follow the existing names (see `.context/machines.md`); propose one.
- **Tailnet hostname**: `workdone-NAME` unless the machine is already on the tailnet.
- **Herdr label** for the Mac's sidebar (`herdr machine add ... --label`); the user may want a friendlier name than NAME.
- **Work root(s)**: where agents may work. `/data/workspace` on instabox, `~/src` elsewhere.
- **Capabilities**: they start off. The human decides. Offer "same as the other machines" (check `bridge_status` on them) and say what `allowExec` means: ChatGPT can run anything that user can.
- **Repos to clone** and which agent CLIs it needs (default: Claude Code and Codex).

## 1. Make the host reachable and fit

Get a shell as the user the agents will run as (not root; create one with passwordless sudo if the provider only gives root). Then check:

- `/dev/net/tun` exists. Without it Tailscale runs in userspace mode, sshd stops seeing the real tailnet source IP, and the `from=` restriction on OVH's key fails.
- sshd is the system OpenSSH, honours `~/.ssh/authorized_keys` (`sudo sshd -T | grep -i authorizedkeys`; an `AuthorizedKeysCommand` other than `none` breaks the forced key), and `/etc/ssh/ssh_host_ed25519_key.pub` is readable.
- It is not Tailscale SSH. After joining, `tailscale debug prefs | grep RunSSH` must say false. If it says true, the human decides; do not turn it off yourself.
- Disk: agents plus `node_modules` need several GB in the work root.

On Linux, `scripts/linux-prep.sh ROOT TAILNET_HOSTNAME` does the install part: Bun at `~/.bun/bin/bun`, Tailscale, the work root, Claude Code's first-run settings, a systemd user unit for Herdr with linger, and it prints the Tailscale login link. Pipe it in so nothing needs copying first:

```bash
ssh FIRST_SHELL 'sh -s ROOT workdone-NAME' < skills/workdone-add-machine/scripts/linux-prep.sh
```

It is safe to rerun. macOS and NAS machines differ; see `references/hosts.md`.

## 2. Herdr, same version as the others

Every machine runs the same Herdr version, and the Mac's Herdr talks to each of them over `herdr machine`, so match it rather than taking whatever an installer gives today. Check the version on OVH (`ssh ovh '~/.local/bin/herdr --version'`) and the Mac (`herdr --version`).

- Linux x86_64: copy OVH's binary and compare checksums. It is about 30 MB; `ssh ovh 'cat ~/.local/bin/herdr' | ssh FIRST_SHELL 'mkdir -p ~/.local/bin && cat > ~/.local/bin/herdr.new && chmod 755 ~/.local/bin/herdr.new && mv ~/.local/bin/herdr.new ~/.local/bin/herdr'`. (`instabox exec --stdin` caps at 1 MB; use `instabox ssh`.) Then rerun `linux-prep.sh` (or `systemctl --user enable --now herdr`): on a fresh machine the first run only wrote the unit, and `restart` alone would not enable it for the next boot.
- macOS: `brew install herdr`, pinned to the same version.

The server has to survive reboots and, on instabox, stops. It also has to start from a login shell so panes get the PATH and env (the unit from `linux-prep.sh` does both). Check `herdr status server` says running and `~/.config/herdr/herdr.sock` exists.

## 3. Join the tailnet

`linux-prep.sh` prints a `https://login.tailscale.com/a/...` link. Approve it in Chrome with Claude in Chrome (account in `.context/machines.md`): sign in with Google, pick the account, press Connect. Then on the machine: `tailscale ip -4` gives the 100.x address and `ip -br link | grep tailscale0` shows a real tun device.

The tailnet policy is "accept all" today, so no ACL change is needed. If that has changed, merge a grant for OVH to the new machine's tcp:22 and do not replace the policy.

If Claude in Chrome says the extension is not connected, see "Claude in Chrome" in `references/hosts.md` before asking the user.

## 4. Mac to machine SSH alias

`add-machine.sh` reads host, port and user from `ssh -G ALIAS` on the Mac, and OVH connects to the same address, so the alias must be plain OpenSSH to the tailnet IP (not `instabox ssh`, not a provider proxy).

```bash
ssh-keygen -q -t ed25519 -a 100 -N '' -C "mac->workdone-NAME" -f ~/.ssh/id_ed25519_workdone_NAME
# put the .pub into the machine's ~/.ssh/authorized_keys through the first shell
cp ~/.ssh/config ~/.ssh/config.bak-$(date +%Y%m%d%H%M%S)
cat >> ~/.ssh/config <<'EOF'

Host workdone-NAME
  HostName 100.x.y.z
  User USER
  IdentityFile ~/.ssh/id_ed25519_workdone_NAME
  IdentitiesOnly yes
EOF
```

Pin the host key from a trusted path: read `/etc/ssh/ssh_host_ed25519_key.pub` through the first shell and append `100.x.y.z <type> <key>` to `~/.ssh/known_hosts`. Never `StrictHostKeyChecking=no`. Then `ssh -o BatchMode=yes workdone-NAME 'hostname; whoami; echo $HOME'`.

## 5. Agent CLIs and sign-ins

Install the CLIs the user wants if missing (`npm i -g @anthropic-ai/claude-code @openai/codex`; on a plain VPS that may need sudo or an npm prefix under HOME, and panes must find them on the login PATH; instabox's universal template has both). Never print a token, read a credential file into output, or echo a value. Check presence only: `test "${NAME+x}" = x`, `test -f FILE`.

- **GitHub and git**: `GH_TOKEN` from `gh auth token` piped straight into the target (instabox: the `instabox-basic-setup` skill puts it and `.gitconfig` in the Vault for every box). Elsewhere, write it to an env file sourced by the login profile, mode 600.
- **Claude Code**: a 1-year `CLAUDE_CODE_OAUTH_TOKEN`. Run `claude setup-token` on the Mac in a detached tmux session, open the printed authorize URL in Chrome (Authorize as the user's account), type the code the page shows back into tmux, then pipe the token from `tmux capture-pane -p -J` through `grep -o 'sk-ant-oat[A-Za-z0-9_-]*'` (not after `tr -d ' \n'`, which glues the next words onto it; the token is 108 characters) into the destination (`instabox vault set CLAUDE_CODE_OAUTH_TOKEN` or the env file). Kill the tmux session afterwards. On instabox the Vault item reaches every box, so make it once; elsewhere reuse the same token (one token served five instabox boxes at once on 2026-10-15). Claude's header then says "Claude API"; billing still goes to the subscription (the token only exists for subscriptions). A per-box `/login` fixes the label but only if the env token is not set.
- **Claude first-run dialogs**: agents start in panes nobody watches. `~/.claude.json` needs `hasCompletedOnboarding: true` and `~/.claude/settings.json` needs `skipDangerousModePermissionPrompt: true` and `tui: "fullscreen"`, or the agent sits on a login picker, the Bypass Permissions warning, or a renderer offer. `linux-prep.sh` sets them; do it by hand elsewhere. New Claude Code releases add new first-run prompts: the smoke test in step 8 is how you find them.
- **Codex**: a ChatGPT login cannot be copied (its refresh token rotates). Start `codex login --device-auth` on the machine in the background (`nohup setsid ... > /tmp/codex-login.log 2>&1 &`), open `https://auth.openai.com/codex/device` in Chrome and enter the code. OpenAI asks for the user's passkey; tell them to approve Touch ID in Chrome right away, because the code expires in 15 minutes. `codex login status` should say "Logged in using ChatGPT". Delete the log after.
- Herdr's environment is fixed at start. After adding env tokens (on instabox, `instabox vault push BOX` first), restart Herdr (no panes yet, so nothing is lost) and confirm the server process has them: `tr '\0' '\n' < /proc/$(pgrep -f '^[^ ]*/herdr server' | head -1)/environ | grep -c '^CLAUDE_CODE_OAUTH_TOKEN='` (count only). The anchored pattern matters: a bare `pgrep -f 'herdr server'` also matches the shell running the check and reports 0.

## 6. Register with WorkDone

`add-machine.sh` ends by redeploying the MCP to OVH from the tree it runs in. Run it from a clean worktree at the commit OVH runs now, or you ship unreleased code. Find that commit by comparing a file's hash on OVH (`sudo sha256sum /opt/herdr-chatgpt-bridge/mcp/src/watch.html`) with `git show COMMIT:mcp/src/watch.html | shasum -a 256` for recent release commits, and check `.context` and memory for the last deploy.

```bash
repo=$(git rev-parse --show-toplevel); wt=$(mktemp -d)/release-COMMIT
git -C "$repo" worktree add --detach "$wt" COMMIT
(cd "$wt" && sh scripts/add-machine.sh NAME workdone-NAME 'ROOT')     # quote ~ so this shell does not expand it
git -C "$repo" worktree remove "$wt"
```

Expect every machine's `bridge_status` line at the end, the new one with all capabilities false. Then `ssh ovh 'systemctl is-active herdr-mcp openai-herdr-tunnel workdone-mcp-bridge'`: three `active` (a herdr-mcp restart can leave its dependents down).

## 7. Capabilities

Apply what the user chose in step 0. The script prints the all-on command; for a subset, set only those keys. Back up `gateway.json` first and keep it mode 600. `bridge_status` reflects the change without a restart.

## 8. Prove it end to end

```bash
sh skills/workdone-add-machine/scripts/smoke.sh NAME 'ROOT'     # SMOKE_WAIT=60 for a slow first start
```

A paused instabox box fails every call with `machine_offline`: `instabox resume BOX` first.

It goes through OVH with the machine's own forced key, the same path ChatGPT uses, spawns a disposable Claude and Codex agent, and prints the last lines of each screen. Pass: each ends with `ok-NAME-claude` / `ok-NAME-codex`, and both closes say `"closed":true`. A login picker, a theme or renderer prompt, or the Bypass Permissions warning means step 5 is incomplete: fix the setting, close the pane on the machine with `~/.local/bin/herdr pane close PANE`, and rerun.

## 9. Herdr on the Mac

```bash
herdr machine add workdone-NAME --label LABEL
herdr machine status        # LABEL reachable
```

Open Herdr clients connect by themselves. Agents ChatGPT spawns on NAME appear in the sidebar under LABEL, and the other way round.

## 10. Clone repos

Clone into the root over HTTPS with the GitHub token (`git clone https://github.com/OWNER/REPO.git`). A fresh clone is not the Mac's checkout: tell the user if their local branch is ahead or dirty (`git rev-list --left-right --count main...origin/main`, `git status --short | wc -l`), and offer `instabox-move-repo` on instabox. Read the repo's `packageManager` and `engines` before installing dependencies; instabox has Node 22, and some repos need 24.

## 11. Record and report

- Add a row to `.context/machines.md`: NAME, label, where it lives, tailnet host and IP, user, root, alias, key file, capabilities, CLIs and how each is signed in, date.
- ChatGPT's skill text (`plugin/herdr-remote/skills/herdr-remote/SKILL.md`) names the machines. `bridge_status` already lists the new one, so this is optional; if the user wants it named, it ships with the next plugin release (`workdone-release` skill).
- Tell the user: the machine's NAME and label, what the smoke test printed, capabilities, what still needs a human, and anything that will bite later: a box that pauses shows as `machine_offline`, and Tailscale node keys expire unless key expiry is disabled for that device in the admin console.

## Cloning a finished machine

A snapshot or image of a working machine carries its identity. Before saving one: `sudo tailscale logout`, `sudo rm /etc/ssh/ssh_host_*`, and remove OVH's and the Mac's lines from `~/.ssh/authorized_keys`. On each copy: `sudo ssh-keygen -A`, a new tailnet hostname and login link, a new Codex device login, then steps 4 and 6 to 9 with a new NAME. OVH must get a key of its own and pin the copy's host key, so never reuse the original's `machines` entry.

## Removing a machine

Delete `machines.NAME` from `/etc/herdr-mcp/ovh.json` on OVH (back it up), drop its line from `/etc/herdr-mcp/ssh/known_hosts` and its key `id_ed25519_NAME*`, restart `herdr-mcp` and its dependents, `herdr machine remove LABEL` on the Mac, remove the ssh alias, and delete the device in the Tailscale admin. Ask before each irreversible part.
