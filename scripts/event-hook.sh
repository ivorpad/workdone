#!/usr/bin/env bash
# Add or remove a hook.* event on OVH, or switch a built-in event off and on, while
# herdr-mcp keeps running. Edits the file at events.sourcesPath in ovh.json (backed up),
# then sends herdr-mcp SIGHUP. If the server refuses the new file, the backup goes back.
# ChatGPT sees the change after Refresh tools on the Events app, in a new chat.
#
# add makes a whsec_ signing secret in /etc/herdr-mcp/hooks/<name>.secret and never prints
# it. Give it to the sending service yourself: ssh <host> sudo cat <that file>.
# A payloadSchema is added by editing the sources file (see mcp/src/hooks.ts), then reload.
#
# usage: scripts/event-hook.sh [--host ovh] add <name> <description>
#        scripts/event-hook.sh [--host ovh] remove <name>
#        scripts/event-hook.sh [--host ovh] disable|enable <built-in event>
#        scripts/event-hook.sh [--host ovh] list
set -euo pipefail
host=ovh
if [ "${1:-}" = --host ]; then host=$2; shift 2; fi
cmd=${1:-}
case "$cmd" in
  add) [ $# -eq 3 ] || { echo "usage: $0 add <name> <description>" >&2; exit 2; } ;;
  remove|disable|enable) [ $# -eq 2 ] || { echo "usage: $0 $cmd <name>" >&2; exit 2; } ;;
  list) ;;
  *) sed -n '11,15p' "$0" >&2; exit 2 ;;
esac
if [ "$cmd" = add ] || [ "$cmd" = remove ]; then
  [[ $2 =~ ^[a-z0-9][a-z0-9_-]{0,47}$ ]] || { echo "name must be lowercase letters, digits, - or _ (up to 48)" >&2; exit 2; }
fi

ssh "$host" "bash -s -- $(printf '%q ' "$@")" <<'REMOTE'
set -euo pipefail
cmd=$1
cfg=/etc/herdr-mcp/ovh.json
# A herdr-mcp from before hooks has no SIGHUP handler, and SIGHUP would kill it.
if ! grep -q SIGHUP /opt/herdr-chatgpt-bridge/mcp/src/server.ts; then
  echo "the deployed herdr-mcp predates hooks: deploy first (scripts/deploy-ovh.sh --mcp-only)" >&2
  exit 1
fi
src=$(sudo jq -r '.events.sourcesPath // empty' "$cfg")
if [ -z "$src" ]; then
  echo "events.sourcesPath is not set in $cfg. Set it (and events.hooksPort for inbound hooks) and restart herdr-mcp once." >&2
  exit 1
fi
current=$(sudo cat "$src" 2>/dev/null || echo '{}')
if [ "$cmd" = list ]; then
  jq '{disabled: (.disabled // []), hooks: ((.hooks // {}) | with_entries(.value = .value.description))}' <<<"$current"
  exit 0
fi

ts=$(date +%Y%m%d%H%M%S)
dir=/etc/herdr-mcp/hooks
case "$cmd" in
  add)
    name=$2; secret=$dir/$name.secret
    sudo install -d -m 750 -o root -g herdr-mcp "$dir"
    if ! sudo test -e "$secret"; then
      sudo sh -c "umask 027; printf 'whsec_%s\n' \"\$(openssl rand -base64 32)\" > '$secret'"
      sudo chgrp herdr-mcp "$secret"
      echo "new secret in $secret"
    fi
    next=$(jq --arg n "$name" --arg d "$3" --arg f "$secret" '.hooks[$n] = ((.hooks[$n] // {}) + {description: $d, secretFile: $f})' <<<"$current") ;;
  remove)
    next=$(jq --arg n "$2" 'del(.hooks[$n])' <<<"$current") ;;
  disable)
    next=$(jq --arg n "$2" '.disabled = ((.disabled // []) + [$n] | unique)' <<<"$current") ;;
  enable)
    next=$(jq --arg n "$2" '.disabled = ((.disabled // []) - [$n])' <<<"$current") ;;
esac

write() {
  printf '%s\n' "$1" | sudo tee "$src.new" >/dev/null
  sudo chown root:herdr-mcp "$src.new"; sudo chmod 640 "$src.new"; sudo mv "$src.new" "$src"
}
reload() {
  local since; since=$(date '+%Y-%m-%d %H:%M:%S')
  sudo systemctl kill -s HUP --kill-whom=main herdr-mcp
  for _ in 1 2 3 4 5; do
    sleep 1
    sudo journalctl -u herdr-mcp --since "$since" --no-pager -o cat | grep -E '"event":"events_sources' | tail -1 | grep . && return 0
  done
  return 0
}
sudo test -e "$src" && sudo cp -p "$src" "$src.bak-$ts"
write "$next"
line=$(reload)
echo "$line"
if ! grep -q '"events_sources"' <<<"$line"; then
  echo "herdr-mcp did not take the new list; restoring the previous one" >&2
  if sudo test -e "$src.bak-$ts"; then sudo cp -p "$src.bak-$ts" "$src"; else sudo rm -f "$src"; fi
  reload >/dev/null
  exit 1
fi
if [ "$cmd" = remove ]; then sudo rm -f "$dir/$2.secret"; fi
echo "done. Press Refresh tools on the WorkDone Events app; open chats keep the old list."
REMOTE
