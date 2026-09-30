#!/bin/sh
# Send a message to the ChatGPT thread linked with this agent (watch_here). Run it from
# the agent's own Herdr pane: the pane ID comes from $HERDR_PANE_ID. The linked chat's
# card brings it in within about 20 s, and the thread answers with prompt_agent.
#
# usage: scripts/tell.sh "message"      (up to 4000 characters)
set -eu
[ -n "${HERDR_PANE_ID:-}" ] || { echo "tell: not in a Herdr pane (HERDR_PANE_ID is unset)" >&2; exit 2; }
[ $# -eq 1 ] || { echo 'usage: tell.sh "message"' >&2; exit 2; }
launcher=${HERDR_GATEWAY_LAUNCHER:-$HOME/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh}
bun=$(cat "$(dirname "$launcher")/bun-path" 2>/dev/null || command -v bun)
"$bun" -e 'process.stdout.write(JSON.stringify({ id: "tell", op: "tell", params: { pane_id: process.env.HERDR_PANE_ID, text: process.argv[1] } }) + "\n")' "$1" | "$launcher"
