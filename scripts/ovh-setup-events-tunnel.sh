#!/bin/sh
# Run on OVH as a sudoer, after the OAuth listener exists on 127.0.0.1:8789:
#   sudo sh scripts/ovh-setup-events-tunnel.sh tunnel_<32 hex>
# Makes the second tunnel profile (herdr-mcp-events) for the OAuth listener, beside the
# No Auth one. It reuses the runtime key already in /etc/herdr-mcp/tunnel.env (that key
# has Tunnels Read + Use for the organization), so no key is typed or printed here.
# The tunnel id is the second tunnel created in the OpenAI platform for the OAuth listener.
# Port 8789, not 8788, because another service held 127.0.0.1:8788 on the original host.
set -eu
tunnel_id=${1:?usage: $0 tunnel_<id>}
case $tunnel_id in tunnel_*) ;; *) echo "tunnel id should start with tunnel_" >&2; exit 2 ;; esac
env_file=/etc/herdr-mcp/tunnel.env
profile_dir=/etc/herdr-mcp/tunnel-client
tc=/opt/tunnel-client/tunnel-client
here=$(cd "$(dirname "$0")/.." && pwd)

[ -r "$env_file" ] || { echo "$env_file not readable: run with sudo" >&2; exit 2; }
curl -fsS -o /dev/null -m 3 http://127.0.0.1:8789/healthz || { echo "nothing answers on 127.0.0.1:8789 yet; deploy the MCP with auth.listenPort 8789 first" >&2; exit 1; }

cd /tmp
run_as() { runuser -u herdr-mcp -- env HOME=/var/lib/herdr-mcp TUNNEL_CLIENT_PROFILE_DIR="$profile_dir" "$@"; }
set -a; . "$env_file"; set +a
# A different admin port from the first profile (127.0.0.1:8080).
run_as "$tc" init --sample sample_mcp_with_dcr --profile herdr-mcp-events --force \
  --tunnel-id "$tunnel_id" --mcp-server-url http://127.0.0.1:8789/mcp
sed -i 's#listen_addr: "127.0.0.1:8080"#listen_addr: "127.0.0.1:8081"#' "$profile_dir/herdr-mcp-events.yaml"
run_as "$tc" doctor --profile herdr-mcp-events --explain || { echo "doctor failed; fix the above before starting the service" >&2; exit 1; }
unset CONTROL_PLANE_API_KEY

install -m 644 "$here/deploy/systemd/openai-herdr-events-tunnel.service" /etc/systemd/system/openai-herdr-events-tunnel.service
systemctl daemon-reload
systemctl enable openai-herdr-events-tunnel.service
systemctl restart openai-herdr-events-tunnel.service
sleep 5
systemctl --no-pager --lines=15 status openai-herdr-events-tunnel.service || true
curl -fsS http://127.0.0.1:8081/readyz && echo
