#!/bin/sh
# Wakes a paused instabox box. Installed on the machine that holds the instabox API key
# (see the instabox notes in skills/workdone-add-machine/references/hosts.md); the MCP's
# wake_machine tool runs it there through that machine's gateway exec.
#
# usage: instabox-wake.sh BOX
#   key:  ~/.config/workdone-wake/api-key (mode 600, machines:read + machines:write)
#   CLI:  ~/.local/bin/instabox
# Prints one JSON line: {"box":..., "before":..., "state":...}. Exit 0 when the box runs.
set -eu
box=${1:?usage: instabox-wake.sh BOX}
case $box in *[!a-z0-9_-]*|-*) echo "bad box name" >&2; exit 2 ;; esac
cli=$HOME/.local/bin/instabox
INSTABOX_API_KEY=$(cat "$HOME/.config/workdone-wake/api-key")
export INSTABOX_API_KEY

state() { "$cli" get "$box" --json | /usr/bin/jq -r .state; }
before=$(state)
case $before in
  running) ;;
  suspended|paused) "$cli" resume "$box" >/dev/null ;;
  stopped) "$cli" start "$box" >/dev/null ;;
  *) echo "{\"box\":\"$box\",\"before\":\"$before\",\"error\":\"cannot wake from this state\"}"; exit 1 ;;
esac
after=$(state)
echo "{\"box\":\"$box\",\"before\":\"$before\",\"state\":\"$after\"}"
[ "$after" = running ]
