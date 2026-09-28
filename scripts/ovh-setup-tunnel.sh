#!/bin/sh
# Run on OVH as a sudoer: sudo sh scripts/ovh-setup-tunnel.sh tunnel_<32 hex>
# Reads the restricted runtime key (Tunnels: Read + Use) from a hidden prompt or stdin.
set -eu
tunnel_id=${1:?usage: $0 tunnel_<id>}
case $tunnel_id in tunnel_*) ;; *) echo "tunnel id should start with tunnel_" >&2; exit 2 ;; esac

env_file=/etc/herdr-mcp/tunnel.env
profile_dir=/etc/herdr-mcp/tunnel-client
tc=/opt/tunnel-client/tunnel-client

if [ -t 0 ]; then
  printf 'CONTROL_PLANE_API_KEY (input hidden): ' >&2
  stty -echo; read -r key; stty echo; echo >&2
else
  read -r key || true   # piped in, e.g. pbpaste | ssh host sudo sh this-script tunnel_...
fi
[ -n "$key" ] || { echo "empty key" >&2; exit 2; }
# Check the shape without printing any of it.
case $key in
  sk-*) ;;
  *) echo "that does not look like an OpenAI API key (expected sk-...); nothing written" >&2; exit 2 ;;
esac
case $key in *[!A-Za-z0-9_-]*) echo "key contains unexpected characters (spaces or quotes?); nothing written" >&2; exit 2 ;; esac

[ -e "$env_file" ] && cp -p "$env_file" "$env_file.bak-$(date +%Y%m%d%H%M%S)"
umask 077
printf 'CONTROL_PLANE_API_KEY=%s\n' "$key" > "$env_file"
chown herdr-mcp:herdr-mcp "$env_file"; chmod 600 "$env_file"
unset key

install -d -m 750 -o herdr-mcp -g herdr-mcp "$profile_dir"
# runuser keeps the caller's cwd, which herdr-mcp usually cannot read.
cd /tmp
run_as() { runuser -u herdr-mcp -- env HOME=/var/lib/herdr-mcp TUNNEL_CLIENT_PROFILE_DIR="$profile_dir" "$@"; }

# The key reaches init/doctor only through the environment, never argv.
set -a; . "$env_file"; set +a
run_as "$tc" init --sample sample_mcp_remote_no_auth --profile herdr-mcp --force \
  --tunnel-id "$tunnel_id" --mcp-server-url http://127.0.0.1:8787/mcp
run_as "$tc" doctor --profile herdr-mcp --explain || {
  echo "doctor failed; fix the above before starting the service" >&2; exit 1; }
unset CONTROL_PLANE_API_KEY

systemctl enable openai-herdr-tunnel.service
systemctl restart openai-herdr-tunnel.service
sleep 5
systemctl --no-pager --lines=15 status openai-herdr-tunnel.service || true
curl -fsS http://127.0.0.1:8080/readyz && echo
