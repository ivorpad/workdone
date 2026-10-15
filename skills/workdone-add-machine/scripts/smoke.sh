#!/bin/sh
# End-to-end check of a WorkDone machine, run from the workstation. Goes the way
# the MCP goes: on OVH, as herdr-mcp, with the machine's forced-command key. For
# each agent CLI it spawns a disposable agent in ROOT with a one-line prompt,
# waits, prints the tail of its screen, and closes the pane.
#
# usage: smoke.sh NAME ROOT [KIND...]      KIND defaults to: claude codex
#   OVH_HOST overrides the server alias (default: ovh); SMOKE_WAIT the wait in seconds (30).
# A healthy agent ends its screen with "ok-NAME-KIND". A login menu, a theme
# picker or a "Bypass Permissions" warning means the CLI is not ready (SKILL.md).
set -eu
name=${1:?usage: smoke.sh NAME ROOT [KIND...]}
root=${2:?usage: smoke.sh NAME ROOT [KIND...]}
shift 2
[ $# -gt 0 ] || set -- claude codex
ovh=${OVH_HOST:-ovh}

# One gateway call: JSON request on stdin, JSON reply on stdout. The request goes over
# stdin, never into the remote command line, so quotes and $ in it are safe.
remote='m=$(sudo jq -c --arg n "$1" ".machines[\$n]" /etc/herdr-mcp/ovh.json)
[ "$m" != null ] || { echo "{\"ok\":false,\"error\":{\"code\":\"no_machine\"}}"; exit 0; }
f() { printf %s "$m" | jq -r ".$1"; }
sudo -u herdr-mcp ssh -T -o BatchMode=yes -i "$(f identityFile)" -o UserKnownHostsFile="$(f knownHostsFile)" -p "$(f port)" "$(f user)@$(f host)"'
call() { printf '%s\n' "$1" | ssh -o BatchMode=yes "$ovh" "bash -c '$remote' _ $name"; }

echo "== bridge_status"
call '{"id":"s","op":"bridge_status","params":{}}' | jq -c '{ok, herdr: .result.herdr_version, roots: .result.allowed_roots, caps: .result.capabilities, kinds: .result.agent_kinds, error}'

panes=""
for kind in "$@"; do
  req=$(jq -cn --arg k "$kind" --arg n "smoke-$kind" --arg r "$root" --arg p "Reply with exactly: ok-$name-$kind" \
    '{id:"p",op:"spawn_agent",params:{kind:$k,name:$n,cwd:$r,prompt:$p,disposable:true,coordinator:false,watch:false}}')
  # spawn mints a lease for a caller without one; close needs it back.
  got=$(call "$req" | jq -r 'if .ok then "\(.result.pane.pane_id),\(.result.lease)" else "ERR " + (.error|tostring) end')
  echo "== spawn $kind: ${got%%,*}"
  case $got in ERR*) continue ;; esac
  panes="$panes $got"
done

sleep "${SMOKE_WAIT:-30}"
for got in $panes; do
  pane=${got%%,*} lease=${got#*,}
  echo "== $pane"
  call "$(jq -cn --arg t "$pane" '{id:"r",op:"read_agent",params:{target:$t}}')" |
    jq -r '.result.text // .result.screen // (.result|tostring)' | grep -v '^[[:space:]]*$' | tail -8 | cut -c1-160
  call "$(jq -cn --arg t "$pane" --arg l "$lease" '{id:"c",op:"close",params:{kind:"pane",id:$t,even_if_working:true,lease:$l}}')" | jq -c '{closed: .ok, error}'
done
