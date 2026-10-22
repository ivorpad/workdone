#!/bin/sh
# Claude Code hook for WorkDone (gateway/hooks.ts), installed as workdone-hook and added
# to ~/.claude/settings.json by install-gateway.sh. It tells this machine's gateway that
# the pane's agent has hooks (SessionStart), matches a prompt WorkDone typed so the agent
# learns who sent it (UserPromptSubmit), and hands over the final answer (Stop).
#
# It runs on every prompt in every Claude Code session, so it costs nothing outside a
# Herdr pane, and inside one it starts nothing unless the gateway left a flag for the
# pane (a WorkDone message on its way, or one recent enough to be continued). It always
# exits 0 and prints nothing but the prompt's context.
#
# usage: workdone-hook SessionStart|UserPromptSubmit|Stop   (hook input JSON on stdin)
pane=${HERDR_PANE_ID:-}
case "$pane" in ""|*[!A-Za-z0-9:_-]*) exit 0 ;; esac
launcher=${HERDR_GATEWAY_LAUNCHER:-$HOME/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh}
dir=$(dirname "$launcher")
[ -r "$dir/hook-cli.ts" ] || exit 0
case "${1:-}" in
  SessionStart) ;;
  UserPromptSubmit|Stop)
    state=$(cat "$dir/state-dir" 2>/dev/null) || exit 0
    [ -e "$state/hook-panes/$pane" ] || exit 0 ;;
  *) exit 0 ;;
esac
bun=$(cat "$dir/bun-path" 2>/dev/null || command -v bun) || exit 0
"$bun" --no-env-file "$dir/hook-cli.ts" "$1" 2>/dev/null || true
exit 0
