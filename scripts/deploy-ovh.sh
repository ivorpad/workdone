#!/bin/sh
# Deploy the bridge to OVH, run from the Mac. Copies the repo, installs the OVH
# gateway for debian, gives the MCP service a forced-command key to it (usable
# only from 127.0.0.1), deploys the MCP server with both machines and restarts it.
# Safe to rerun: each step checks before it changes anything and backs up what it
# edits. It never touches the capability flags in OVH's gateway.json.
#
# usage: scripts/deploy-ovh.sh [ssh-host]      (default: ovh)
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
host=${1:-ovh}

echo "== copying $repo to $host:~/herdr-chatgpt-bridge-staging"
COPYFILE_DISABLE=1 tar -C "$repo" --no-xattrs --exclude=node_modules --exclude=.git --exclude=dist -czf - . |
  ssh "$host" 'rm -rf ~/herdr-chatgpt-bridge-staging && mkdir -m 700 ~/herdr-chatgpt-bridge-staging && tar -C ~/herdr-chatgpt-bridge-staging -xzf -'

ssh "$host" 'bash -s' <<'REMOTE'
set -euo pipefail
stage=$HOME/herdr-chatgpt-bridge-staging
launcher=$HOME/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh
key=/etc/herdr-mcp/ssh/id_ed25519_ovh
kh=/etc/herdr-mcp/ssh/known_hosts
cfg=/etc/herdr-mcp/ovh.json
ts=$(date +%Y%m%d%H%M%S)

echo "== gateway for $USER"
install -d -m 700 ~/.config/herdr-chatgpt
[ -e ~/.config/herdr-chatgpt/gateway.json ] || install -m 600 "$stage/config/ovh-gateway.example.json" ~/.config/herdr-chatgpt/gateway.json
BUN=/usr/local/bin/bun sh "$stage/scripts/install-gateway.sh"
# This gateway sends the phone notifications for every machine, through the notify
# skill's apprise gateway. Set it only when nothing is configured yet.
gw=~/.config/herdr-chatgpt/gateway.json
if [ -r ~/.agents/skills/notify/scripts/notify.sh ] && [ -z "$(jq -r '.notifyCommand // empty' "$gw")" ]; then
  cp -p "$gw" "$gw.bak-$ts"
  jq '.notifyCommand = ["/bin/bash", "~/.agents/skills/notify/scripts/notify.sh", "send", "-k", "phone", "-t", "WorkDone", "-m"]' "$gw.bak-$ts" > "$gw.tmp"
  chmod 600 "$gw.tmp"
  mv "$gw.tmp" "$gw"
  echo "notifyCommand: notify.sh send -k phone"
fi

echo "== key for herdr-mcp"
sudo test -e "$key" || sudo -u herdr-mcp ssh-keygen -q -t ed25519 -a 100 -N "" -C herdr-chatgpt-ovh-local -f "$key"
sudo ssh-keygen -lf "$key.pub"

echo "== authorized_keys"
pub=$(sudo cat "$key.pub")
if grep -qF "$(echo "$pub" | awk '{print $2}')" ~/.ssh/authorized_keys; then
  echo "already authorized"
else
  cp -p ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-"$ts"
  tmp=$(mktemp)
  echo "$pub" > "$tmp"
  sh "$stage/scripts/render-authorized-key.sh" 127.0.0.1 "$launcher" "$tmp" >> ~/.ssh/authorized_keys
  rm -f "$tmp"
  echo "added; backup in ~/.ssh/authorized_keys.bak-$ts"
fi

echo "== host key for 127.0.0.1"
hk="127.0.0.1 $(awk '{print $1" "$2}' /etc/ssh/ssh_host_ed25519_key.pub)"
sudo grep -qxF "$hk" "$kh" || echo "$hk" | sudo -u herdr-mcp tee -a "$kh" >/dev/null

echo "== bridge_status through the new key"
printf '%s\n' '{"id":"1","op":"bridge_status","params":{}}' |
  sudo -u herdr-mcp /usr/bin/ssh -F /dev/null -T -i "$key" -o BatchMode=yes -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$kh" -o GlobalKnownHostsFile=/dev/null \
    -o ClearAllForwardings=yes -o RequestTTY=no -l "$USER" 127.0.0.1 |
  jq -ec 'select(.ok) | {herdr: .result.herdr_version, roots: .result.allowed_roots}'

echo "== MCP server"
sudo rm -rf /opt/herdr-chatgpt-bridge.new
sudo cp -r "$stage" /opt/herdr-chatgpt-bridge.new
sudo chown -R root:root /opt/herdr-chatgpt-bridge.new
(cd /opt/herdr-chatgpt-bridge.new/mcp && sudo /usr/local/bin/bun install --production --frozen-lockfile >/dev/null && sudo /usr/local/bin/bun test 2>&1 | tail -3)
sudo mv /opt/herdr-chatgpt-bridge /opt/herdr-chatgpt-bridge.old-"$ts"
sudo mv /opt/herdr-chatgpt-bridge.new /opt/herdr-chatgpt-bridge

echo "== MCP config"
if sudo jq -e '.machines.ovh' "$cfg" >/dev/null; then
  echo "machines.ovh already set"
else
  sudo cp -p "$cfg" "$cfg.bak-$ts"
  sudo jq --arg user "$USER" --arg key "$key" --arg kh "$kh" '
    (.machines // {mac: .ssh}) as $m
    | del(.ssh)
    | .machines = ($m + {ovh: {binary: "/usr/bin/ssh", user: $user, host: "127.0.0.1", port: 22,
                              identityFile: $key, knownHostsFile: $kh, connectTimeoutSeconds: 5}})
    | .defaultMachine = (.defaultMachine // "mac")' "$cfg.bak-$ts" | sudo tee "$cfg.new" >/dev/null
  sudo chown root:herdr-mcp "$cfg.new"
  sudo chmod 640 "$cfg.new"
  sudo mv "$cfg.new" "$cfg"
fi

if ! sudo jq -e '.notify' "$cfg" >/dev/null; then
  sudo cp -p "$cfg" "$cfg.bak-notify-$ts"
  sudo jq '.notify = {machine: "ovh"}' "$cfg.bak-notify-$ts" | sudo tee "$cfg.new" >/dev/null
  sudo chown root:herdr-mcp "$cfg.new"
  sudo chmod 640 "$cfg.new"
  sudo mv "$cfg.new" "$cfg"
  echo "notifier on, sending through ovh"
fi

echo "== restart"
sudo systemctl restart herdr-mcp
sleep 2
systemctl is-active herdr-mcp
curl -s 127.0.0.1:8787/healthz
echo
curl -s -X POST 127.0.0.1:8787/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bridge_status","arguments":{}}}' |
  jq -r '.result.content[0].text' |
  jq -c 'to_entries[] | {machine: .key, herdr: .value.herdr_version, capabilities: .value.capabilities, error: .value.error.code}'
echo "rollback: sudo mv /opt/herdr-chatgpt-bridge.old-$ts /opt/herdr-chatgpt-bridge (after moving the new one aside), restore $cfg.bak-$ts if it exists, then sudo systemctl restart herdr-mcp"
REMOTE
