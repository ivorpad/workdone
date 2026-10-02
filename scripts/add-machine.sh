#!/bin/sh
# Add a machine to WorkDone, run from the Mac. Installs the gateway on it, gives the
# MCP service on OVH a forced-command key for it that only works from OVH's tailnet
# IP, pins the machine's host key on OVH, adds the machine to the MCP config and
# redeploys the MCP server with scripts/deploy-ovh.sh. Safe to rerun.
#
# The machine needs Bun at ~/.bun/bin/bun and a running Herdr server, and OVH must
# reach it over Tailscale at the address this Mac uses for SSH_ALIAS. Its gateway
# starts with every capability off; the last lines printed say how to turn them on.
#
# usage: scripts/add-machine.sh NAME SSH_ALIAS [ROOT...]
#   e.g. scripts/add-machine.sh syno syno '~/Developer' '~/ai'
#   ROOT defaults to ~/src. Quote ~ so this shell does not expand it.

# Values in remote commands are meant to expand here, before ssh sends them.
# ssh -n wherever a command needs no input, so pasted lines queued behind this
# script are not swallowed and sent to the remote side.
# shellcheck disable=SC2029
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
if [ $# -lt 2 ]; then sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; fi
name=$1
alias=$2
shift 2
printf '%s' "$name" | grep -Eq '^[a-z][a-z0-9-]{0,15}$' || { echo "NAME must match [a-z][a-z0-9-]{0,15}" >&2; exit 2; }
# A literal ~: the gateway expands it on the machine.
# shellcheck disable=SC2088
[ $# -gt 0 ] || set -- '~/src'
ovh=${OVH_HOST:-ovh}
key=/etc/herdr-mcp/ssh/id_ed25519_$name
kh=/etc/herdr-mcp/ssh/known_hosts

# OVH connects the same way this Mac does, so take address, port and user from ssh -G.
host=$(ssh -G "$alias" | awk '$1 == "hostname" {print $2}')
port=$(ssh -G "$alias" | awk '$1 == "port" {print $2}')
user=$(ssh -G "$alias" | awk '$1 == "user" {print $2}')
case $host in
  100.*|*.ts.net) ;;
  *) echo "warning: $host does not look like a tailnet address; OVH has to reach it" >&2 ;;
esac
echo "== $name is $user@$host port $port"

home=$(ssh -n "$alias" 'printf %s "$HOME"')
shell=$(ssh -n "$alias" 'printf %s "${SHELL:-/bin/sh}"')
ssh -n "$alias" 'test -x "$HOME/.bun/bin/bun"' || { echo "no Bun at ~/.bun/bin/bun on $alias; install it first" >&2; exit 1; }
ssh -n "$alias" 'test -S "$HOME/.config/herdr/herdr.sock"' || echo "warning: no Herdr socket on $alias; start the server there (herdr server)" >&2

echo "== gateway config (kept if it already exists)"
roots=$(printf '%s\n' "$@" | jq -R . | jq -sc .)
jq -n --argjson roots "$roots" --arg shell "$shell" '{
    herdrSocketPath: "~/.config/herdr/herdr.sock",
    allowedRoots: $roots, repos: {}, agentKinds: ["claude", "codex"],
    allowExec: false, allowFileRead: false, allowFileWrite: false,
    allowRawPaneRun: false, allowCloseAny: false, allowWorktreeRemove: false,
    shell: $shell, extraPath: ["~/.bun/bin", "~/.local/bin", "~/.npm-global/bin", "/usr/local/bin"],
    transcriptRoots: ["~/.claude/projects"], documentConverter: null, notifyCommand: null,
    maxReadLines: 400, maxPromptChars: 20000, maxWaitMs: 110000, maxFileBytes: 2000000, maxOutputBytes: 60000,
    stateDir: "~/.local/state/herdr-chatgpt"
  }' |
  ssh "$alias" 'install -d -m 700 ~/.config/herdr-chatgpt
    if [ -e ~/.config/herdr-chatgpt/gateway.json ]; then echo "exists, left as is"; cat >/dev/null
    else (umask 077; cat > ~/.config/herdr-chatgpt/gateway.json); echo written; fi'

echo "== gateway files"
COPYFILE_DISABLE=1 tar -C "$repo" --no-xattrs -czf - gateway scripts/install-gateway.sh scripts/tell.sh |
  ssh "$alias" 'rm -rf ~/herdr-chatgpt-gateway-staging && mkdir -m 700 ~/herdr-chatgpt-gateway-staging &&
    tar -C ~/herdr-chatgpt-gateway-staging -xzf - &&
    BUN="$HOME/.bun/bin/bun" sh ~/herdr-chatgpt-gateway-staging/scripts/install-gateway.sh'
launcher=$home/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh
printf '%s\n' '{"id":"1","op":"bridge_status","params":{}}' | ssh "$alias" "$launcher" |
  jq -ec 'select(.ok) | {herdr: .result.herdr_version, roots: .result.allowed_roots}' ||
  { echo "the gateway on $alias does not answer bridge_status" >&2; exit 1; }

echo "== key for herdr-mcp on $ovh"
pub=$(ssh -n "$ovh" "sudo test -e $key || sudo -u herdr-mcp ssh-keygen -q -t ed25519 -a 100 -N '' -C herdr-chatgpt-$name -f $key; sudo cat $key.pub")
ovh_ip=${OVH_TAILNET_IP:-$(ssh -n "$ovh" 'tailscale ip -4 2>/dev/null | head -1')}
printf '%s' "$ovh_ip" | grep -Eq '^100\.[0-9]+\.[0-9]+\.[0-9]+$' || { echo "could not read OVH's tailnet IP; set OVH_TAILNET_IP" >&2; exit 1; }

echo "== authorized_keys on $alias (from=$ovh_ip, forced to the gateway)"
tmp=$(mktemp)
printf '%s\n' "$pub" > "$tmp"
line=$(sh "$repo/scripts/render-authorized-key.sh" "$ovh_ip" "$launcher" "$tmp")
rm -f "$tmp"
blob=$(printf '%s' "$pub" | awk '{print $2}')
printf '%s\n' "$line" | ssh "$alias" "if grep -qF '$blob' ~/.ssh/authorized_keys 2>/dev/null; then echo 'already there'; cat >/dev/null
  else install -d -m 700 ~/.ssh; ts=\$(date +%Y%m%d%H%M%S)
    [ -e ~/.ssh/authorized_keys ] && cp -p ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-\$ts
    cat >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; echo \"added; backup ~/.ssh/authorized_keys.bak-\$ts\"; fi"

echo "== host key of $alias pinned on $ovh"
hostkey=$(ssh -n "$alias" 'cat /etc/ssh/ssh_host_ed25519_key.pub' | awk '{print $1" "$2}')
scanned=$(ssh -n "$ovh" "ssh-keyscan -T 5 -t ed25519 -p $port $host 2>/dev/null" | awk '{print $2" "$3}')
[ -n "$hostkey" ] && [ "$hostkey" = "$scanned" ] || { echo "the host key OVH sees for $host:$port is not the one on $alias; stopping" >&2; exit 1; }
if [ "$port" = 22 ]; then kh_host=$host; else kh_host="[$host]:$port"; fi
ssh -n "$ovh" "sudo grep -qxF '$kh_host $hostkey' $kh || echo '$kh_host $hostkey' | sudo -u herdr-mcp tee -a $kh >/dev/null"

echo "== MCP config on $ovh"
ssh "$ovh" 'bash -s' "$name" "$user" "$host" "$port" "$key" "$kh" <<'REMOTE'
set -euo pipefail
name=$1 user=$2 host=$3 port=$4 key=$5 kh=$6
cfg=/etc/herdr-mcp/ovh.json
ts=$(date +%Y%m%d%H%M%S)
sudo cp -p "$cfg" "$cfg.bak-$ts"
sudo jq --arg n "$name" --arg u "$user" --arg h "$host" --argjson p "$port" --arg k "$key" --arg kh "$kh" '
  (.machines // {mac: .ssh}) as $m | del(.ssh)
  | .machines = ($m + {($n): {binary: "/usr/bin/ssh", user: $u, host: $h, port: $p,
                              identityFile: $k, knownHostsFile: $kh, connectTimeoutSeconds: 10}})
  | .defaultMachine = (.defaultMachine // "mac")' "$cfg.bak-$ts" | sudo tee "$cfg.new" >/dev/null
sudo chown root:herdr-mcp "$cfg.new"
sudo chmod 640 "$cfg.new"
sudo mv "$cfg.new" "$cfg"
echo "machines: $(sudo jq -c '.machines | keys' "$cfg")"
REMOTE

echo "== redeploying the MCP server"
sh "$repo/scripts/deploy-ovh.sh" "$ovh"

echo
echo "$name is added with every capability off. To turn on full access:"
echo "  ssh $alias 'cd ~/.config/herdr-chatgpt && cp -p gateway.json gateway.json.bak && jq \".allowExec = true | .allowFileRead = true | .allowFileWrite = true | .allowRawPaneRun = true | .allowCloseAny = true | .allowWorktreeRemove = true\" gateway.json.bak > gateway.json'"
