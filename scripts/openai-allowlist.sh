#!/bin/sh
# Rewrite the "@not_openai not remote_ip ..." line of a Caddyfile with OpenAI's current
# connector egress prefixes, so only ChatGPT reaches the public /mcp route. Then validate
# and reload the Caddy container. Run on the server as root; rerun when OpenAI's list changes.
#
# usage: scripts/openai-allowlist.sh CADDYFILE [CONTAINER]   (default container: rustdesk-caddy)
set -eu
file=${1:?usage: $0 CADDYFILE [CONTAINER]}
container=${2:-rustdesk-caddy}
json=$(mktemp)
trap 'rm -f "$json"' EXIT
curl -sf -m 20 https://openai.com/chatgpt-connectors.json -o "$json"
cp -p "$file" "$file.bak-$(date +%Y%m%d%H%M%S)"
python3 - "$file" "$json" <<'PY'
import json, re, sys
path, src = sys.argv[1], sys.argv[2]
data = json.load(open(src))
prefixes = [p.get("ipv4Prefix") or p.get("ipv6Prefix") for p in data["prefixes"]]
prefixes = [p for p in prefixes if p]
if len(prefixes) < 10:
    sys.exit(f"only {len(prefixes)} prefixes in OpenAI's list; leaving the Caddyfile alone")
text = open(path).read()
new, n = re.subn(r"(@not_openai not remote_ip)[^\n]*", r"\1 " + " ".join(prefixes), text)
if n == 0:
    sys.exit("no '@not_openai not remote_ip' line in the Caddyfile")
open(path, "w").write(new)
print(f"{len(prefixes)} prefixes from {data.get('creationTime', '?')[:10]}")
PY
docker exec "$container" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
docker exec "$container" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
