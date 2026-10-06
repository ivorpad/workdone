#!/bin/sh
# Report this agent's coordination task to WorkDone (docs/coordination.md). The --token
# from the task slice in your prompt is the authorization: it names one task binding and
# works from any shell, including Claude Code and Codex shell tools that don't pass
# HERDR_PANE_ID on. Without a token, HERDR_PANE_ID works only for a task nobody bound.
# With no JSON it prints your task and the status of what it depends on.
#
# usage: workdone-task --token wdt_... '{"status":"waiting_dependency","blocker":"needs #772","blocker_kind":"dependency"}'
#        workdone-task --token wdt_... '{"result":{"summary":"rate limits shipped","commit":"cc2245e3"},"report_id":"r1"}'
#        workdone-task --token wdt_...            (show my task)
#        WORKDONE_TASK_TOKEN=wdt_... workdone-task '{"acquire":["e2e"]}'
#        workdone-task --token wdt_... '{"release":["e2e@2"],"report_id":"r7"}'   (only generation 2 of e2e)
# A retry of a report reuses its report_id with the same JSON; new content needs a new id.
set -eu
usage='usage: workdone-task [--token wdt_...] [JSON]   (JSON: status, evidence, artifacts, blocker, blocker_kind, wait_for, next_action, result {summary, commit}, acquire, release [name or name@generation], report_id)'
token=${WORKDONE_TASK_TOKEN:-}
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help|help) echo "$usage"; exit 0 ;;
    --token) [ $# -ge 2 ] || { echo "$usage" >&2; exit 2; }; token=$2; shift 2 ;;
    --token=*) token=${1#--token=}; shift ;;
    *) break ;;
  esac
done
[ $# -le 1 ] || { echo "$usage" >&2; exit 2; }
[ -n "$token" ] || [ -n "${HERDR_PANE_ID:-}" ] || { echo "task: pass --token from your task slice (HERDR_PANE_ID is unset here too)" >&2; exit 2; }
launcher=${HERDR_GATEWAY_LAUNCHER:-$HOME/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh}
bun=$(cat "$(dirname "$launcher")/bun-path" 2>/dev/null || command -v bun)
msg=$(WORKDONE_TOKEN_ARG="$token" "$bun" -e '
const raw = process.argv[1] ?? "";
let delta = {};
if (raw.trim()) {
  try { delta = JSON.parse(raw); } catch { console.error("task: the argument must be JSON, e.g. {\"status\":\"executing\"}"); process.exit(2); }
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) { console.error("task: the argument must be a JSON object"); process.exit(2); }
}
const { token: _t, pane_id: _p, ...rest } = delta;
const who = process.env.WORKDONE_TOKEN_ARG ? { token: process.env.WORKDONE_TOKEN_ARG } : { pane_id: process.env.HERDR_PANE_ID };
process.stdout.write(JSON.stringify({ id: "task", op: "coord_report", params: { ...rest, ...who } }) + "\n");
' "${1:-}")
printf '%s\n' "$msg" | "$launcher"
