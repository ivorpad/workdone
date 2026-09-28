#!/bin/sh
# Install the finish-notification watcher as a launchd agent (macOS). Run it after
# install-gateway.sh; it only sends anything when gateway.json has notifyCommand.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
label=dev.ivor.herdr-chatgpt-watcher
dest="$HOME/.local/libexec/herdr-chatgpt"
plist="$HOME/Library/LaunchAgents/$label.plist"
[ -r "$dest/watcher.ts" ] || { echo "run scripts/install-gateway.sh first" >&2; exit 1; }
bun=$(cat "$dest/bun-path")

install -d -m 700 "$HOME/.local/state/herdr-chatgpt"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|@HOME@|$HOME|g" -e "s|@BUN@|$bun|g" "$repo/deploy/launchd/$label.plist" > "$plist"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "loaded $label; log in ~/.local/state/herdr-chatgpt/watcher.log"
