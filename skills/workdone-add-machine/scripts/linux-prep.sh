#!/bin/sh
# Prepare a Linux machine to be a WorkDone machine. Runs ON the machine, as the
# user the agents will run as (not root), with passwordless sudo. Safe to rerun.
#
# Installs Bun at ~/.bun/bin/bun and Tailscale, creates the work root, and adds a
# systemd user unit that keeps the Herdr server running across reboots and stops.
# It does not install Herdr itself (copy the binary, then rerun this, see SKILL.md) and does
# not join the tailnet (that needs a login link a human approves).
#
# usage: sh linux-prep.sh ROOT [TAILNET_HOSTNAME]
#   ROOT              work root to create, e.g. /data/workspace or ~/src
#   TAILNET_HOSTNAME  when given, starts `tailscale up` and prints the login link
set -eu
root=${1:?usage: linux-prep.sh ROOT [TAILNET_HOSTNAME]}
ts_name=${2:-}

say() { printf '== %s\n' "$*"; }

say "work root $root"
case $root in "~"*) root="$HOME${root#\~}" ;; esac
if [ ! -d "$root" ]; then
  mkdir -p "$root" 2>/dev/null || { sudo mkdir -p "$root" && sudo chown "$(id -un):$(id -gn)" "$root"; }
fi

say "bun"
if [ ! -x "$HOME/.bun/bin/bun" ]; then
  curl -fsSL https://bun.sh/install | bash >/dev/null
fi
"$HOME/.bun/bin/bun" --version

say "tailscale"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh >/dev/null
fi
tailscale version | head -1
[ -c /dev/net/tun ] || echo "warning: no /dev/net/tun; tailscale would fall back to userspace mode and from= on the OVH key stops working" >&2

say "sshd"
sudo sshd -T 2>/dev/null | grep -iE '^(pubkeyauthentication|authorizedkeysfile|authorizedkeyscommand) ' || echo "warning: sshd -T failed; is openssh-server installed?" >&2
test -r /etc/ssh/ssh_host_ed25519_key.pub || echo "warning: no readable /etc/ssh/ssh_host_ed25519_key.pub; add-machine.sh needs it" >&2
install -d -m 700 "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"

say "claude code first-run dialogs"
# Agents start in Herdr panes that nobody watches. Without these, Claude Code stops on
# its login picker, the Bypass Permissions warning, or the fullscreen-renderer offer.
"$HOME/.bun/bin/bun" -e '
const fs = require("fs"), h = process.env.HOME;
const merge = (p, add) => {
  let j = {}; try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  fs.mkdirSync(require("path").dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...j, ...add }, null, 2), { mode: 0o600 });
};
merge(h + "/.claude.json", { hasCompletedOnboarding: true });
merge(h + "/.claude/settings.json", { skipDangerousModePermissionPrompt: true, tui: "fullscreen" });
console.log("ok");'

say "herdr service"
herdr=$HOME/.local/bin/herdr
[ -x "$herdr" ] || echo "warning: no Herdr at $herdr yet; copy it before the service can start" >&2
unit=$HOME/.config/systemd/user/herdr.service
mkdir -p "$(dirname "$unit")"
cat > "$unit" <<'EOF'
[Unit]
Description=Herdr server (WorkDone)

[Service]
# A login shell, so panes get the profile's PATH and env (instabox Vault tokens
# live in /run/instabox/vault/env and only login shells source them; wait for it).
# The loop breaks at once off instabox, else waits up to 60 s for the Vault file.
ExecStart=/bin/bash -lc "for i in $(seq 60); do [ ! -d /run/instabox ] || [ -r /run/instabox/vault/env ] && break; sleep 1; done; exec %h/.local/bin/herdr server"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
sudo loginctl enable-linger "$(id -un)" 2>/dev/null || echo "warning: could not enable linger; the server stops when the last session ends" >&2
# A fresh ssh session may have no user bus until linger has started it.
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
systemctl --user daemon-reload || echo "warning: no systemd user bus yet; rerun this script" >&2
if [ -x "$herdr" ]; then
  systemctl --user enable --now herdr.service >/dev/null 2>&1
  sleep 3
  systemctl --user is-active herdr.service
  test -S "$HOME/.config/herdr/herdr.sock" && echo "socket ok" || echo "warning: no Herdr socket yet" >&2
fi

if [ -n "$ts_name" ]; then
  say "tailscale login for $ts_name"
  if tailscale ip -4 >/dev/null 2>&1; then
    echo "already on the tailnet as $(tailscale ip -4 | head -1)"
  else
    # tailscale up blocks until approved; the link stays valid after the timeout.
    sudo timeout 15 tailscale up --hostname="$ts_name" 2>&1 | grep -o 'https://login.tailscale.com/[^ ]*' | head -1 || true
  fi
fi
