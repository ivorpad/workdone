#!/bin/sh
# Report this agent's coordination task to WorkDone, from the agent's own Herdr pane
# ($HERDR_PANE_ID). The task itself (owner, deps, acceptance) is the supervisor's; this
# only changes your slice: status, evidence, artifacts, blocker, next_action, result, and
# exclusive resources (acquire / release). With no argument it prints your task and the
# status of what it depends on.
#
# usage: workdone-task                                   (show my task)
#        workdone-task '{"status":"waiting_dependency","blocker":"needs #772 accepted"}'
#        workdone-task '{"result":{"summary":"rate limits shipped","commit":"cc2245e3"}}'
#        workdone-task '{"acquire":["e2e"]}'
set -eu
usage='usage: workdone-task [JSON]   (no argument: show my task; JSON: status, evidence, artifacts, blocker, next_action, result {summary, commit}, acquire, release, task, objective)'
case "${1:-}" in -h|--help|help) echo "$usage"; exit 0 ;; esac
[ -n "${HERDR_PANE_ID:-}" ] || { echo "task: not in a Herdr pane (HERDR_PANE_ID is unset)" >&2; exit 2; }
[ $# -le 1 ] || { echo "$usage" >&2; exit 2; }
launcher=${HERDR_GATEWAY_LAUNCHER:-$HOME/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh}
bun=$(cat "$(dirname "$launcher")/bun-path" 2>/dev/null || command -v bun)
msg=$("$bun" -e '
const raw = process.argv[1] ?? "";
let delta = {};
if (raw.trim()) {
  try { delta = JSON.parse(raw); } catch { console.error("task: the argument must be JSON, e.g. {\"status\":\"executing\"}"); process.exit(2); }
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) { console.error("task: the argument must be a JSON object"); process.exit(2); }
}
process.stdout.write(JSON.stringify({ id: "task", op: "coord_report", params: { ...delta, pane_id: process.env.HERDR_PANE_ID } }) + "\n");
' "${1:-}")
printf '%s\n' "$msg" | "$launcher"
