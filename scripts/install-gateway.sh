#!/bin/sh
# Install or update the gateway on this machine (macOS or Linux). Never overwrites an
# existing gateway.json. BUN=/path/to/bun picks the runtime; default ~/.bun/bin/bun.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
dest="$HOME/.local/libexec/herdr-chatgpt"
conf="$HOME/.config/herdr-chatgpt/gateway.json"
bun=${BUN:-$HOME/.bun/bin/bun}
[ -x "$bun" ] || { echo "no bun at $bun; set BUN=/path/to/bun" >&2; exit 1; }

install -d -m 700 "$dest" "$(dirname "$conf")"
# Replace the whole module set so a file removed from the repo does not linger.
rm -f "$dest"/*.ts
for f in "$repo"/gateway/*.ts; do
  install -m 600 "$f" "$dest/$(basename "$f")"
done
install -m 700 "$repo/gateway/herdr-gateway-launcher.sh" "$dest/herdr-gateway-launcher.sh"
printf '%s\n' "$bun" > "$dest/bun-path"
chmod 600 "$dest/bun-path"

if [ ! -e "$conf" ]; then
  install -m 600 "$repo/config/mac-gateway.example.json" "$conf"
  echo "wrote $conf from the example; edit allowedRoots and repos"
fi
chmod 600 "$conf"
# Agents in any repo message their linked ChatGPT chat with: workdone-tell "message"
install -d -m 755 "$HOME/.local/bin"
install -m 755 "$repo/scripts/tell.sh" "$HOME/.local/bin/workdone-tell"
# and report their coordination task with: workdone-task '{"status":"executing"}'
install -m 755 "$repo/scripts/task.sh" "$HOME/.local/bin/workdone-task"
echo "installed gateway to $dest (bun: $bun), and workdone-tell and workdone-task to ~/.local/bin"
