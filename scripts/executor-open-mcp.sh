#!/bin/sh
# Let Executor Cloud's servers reach /mcp on OVH, from the Mac:
#   scripts/executor-open-mcp.sh ISSUER_HOST_NAME            drop the OpenAI-only address gate
#   scripts/executor-open-mcp.sh --close ISSUER_HOST_NAME    put it back
# ISSUER_HOST_NAME is the site name in the rustdesk Caddyfile, the one deploy-issuer.sh made.
#
# Opening deletes only the `respond @not_openai 403` line in that site's block. The @not_openai
# matcher stays, so scripts/openai-allowlist.sh keeps working and closing is one line. The
# issuer-signed token is then the only gate on /mcp; docs/executor.md says why Executor needs it
# and what it costs. The Caddyfile is backed up, validated and restored if validation or the
# reload fails, as in deploy-issuer.sh. Safe to rerun: it says when there is nothing to change.
set -eu
mode=open
if [ "${1:-}" = "--close" ]; then mode=close; shift; fi
name=${1:?usage: $0 [--close] ISSUER_HOST_NAME}
host=${OVH_HOST:-ovh}
case $name in *[!a-z0-9.-]*) echo "ISSUER_HOST_NAME should be a lowercase hostname" >&2; exit 2 ;; esac

ssh "$host" "NAME='$name' MODE='$mode' sh -s" <<'REMOTE'
set -eu
cf=${CADDYFILE:-/opt/docker/rustdesk/Caddyfile}
in=$(mktemp); out=$(mktemp)
trap 'rm -f "$in" "$out"' EXIT
sudo cat "$cf" > "$in"
if ! grep -Fxq "$NAME {" "$in"; then echo "no site block named $NAME in $cf" >&2; exit 1; fi
rc=0
if [ "$MODE" = open ]; then
  awk -v name="$NAME" '
    $0 == name " {" { site = 1 }
    site && $0 == "}" { site = 0 }
    site && $0 ~ /^[ \t]*respond @not_openai 403[ \t]*$/ { dropped = 1; next }
    { print }
    END { if (!dropped) exit 3 }
  ' "$in" > "$out" || rc=$?
else
  awk -v name="$NAME" '
    $0 == name " {" { site = 1 }
    site && $0 == "}" { site = 0 }
    site && $0 ~ /^[ \t]*respond @not_openai 403[ \t]*$/ { has = 1 }
    { lines[NR] = $0; inblock[NR] = site }
    END {
      if (has) exit 3
      for (i = 1; i <= NR; i++) {
        print lines[i]
        if (inblock[i] && !done && lines[i] ~ /^[ \t]*@not_openai not remote_ip/) {
          match(lines[i], /^[ \t]*/)
          print substr(lines[i], 1, RLENGTH) "respond @not_openai 403"
          done = 1
        }
      }
      if (!done) exit 4
    }
  ' "$in" > "$out" || rc=$?
fi
case $rc in
  0) ;;
  3) echo "nothing to change: /mcp is already $([ "$MODE" = open ] && echo open || echo closed) in the $NAME block"; exit 0 ;;
  4) echo "no @not_openai matcher in the $NAME block; not touching the Caddyfile" >&2; exit 1 ;;
  *) echo "could not edit the Caddyfile (awk exit $rc); not touching it" >&2; exit 1 ;;
esac
backup="$cf.bak-mcp-$(date +%Y%m%d%H%M%S)-$$"
sudo cp -p "$cf" "$backup"
if ! sudo tee "$cf" < "$out" >/dev/null; then
  echo "could not write $cf; restoring $backup" >&2
  sudo cp -p "$backup" "$cf"
  exit 1
fi
if sudo docker exec rustdesk-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 && sudo docker exec rustdesk-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
  echo "caddy reloaded ($MODE); backup at $backup"
else
  echo "caddy validation or reload failed; restoring $backup" >&2
  sudo cp -p "$backup" "$cf"
  sudo docker exec rustdesk-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
  exit 1
fi
REMOTE
code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "https://$name/mcp" || true)
echo "POST https://$name/mcp from here now answers $code (403 is the address gate, 401 is the MCP asking for a token)"
