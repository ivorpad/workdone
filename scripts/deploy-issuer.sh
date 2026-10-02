#!/bin/sh
# Install the WorkDone issuer on OVH, from the Mac:
#   scripts/deploy-issuer.sh MCP_RESOURCE ISSUER_HOST_NAME
# MCP_RESOURCE is the canonical URL of the OAuth MCP connection (the new tunnel's /mcp URL).
# It becomes the tokens' audience and must equal auth.resource in the MCP config.
# ISSUER_HOST_NAME is the issuer's public name, e.g. <server-ip-with-dashes>.sslip.io (resolves without DNS).
#
# It installs to /opt/workdone-issuer (outside the directory deploy-ovh.sh swaps), makes
# the service user, keys and password on first run, starts the unit on the Docker bridge,
# and adds a site block to the rustdesk Caddy (backed up, validated, rolled back on error).
# The password is generated on OVH into ~/workdone-issuer-password (mode 600) and never
# printed; read it once, put it in a password manager, delete the file.
# Safe to rerun: keys and password are kept, code and config are refreshed.
set -eu
resource=${1:?usage: $0 MCP_RESOURCE ISSUER_HOST_NAME}
name=${2:?usage: $0 MCP_RESOURCE ISSUER_HOST_NAME}
host=${OVH_HOST:-ovh}
here=$(cd "$(dirname "$0")/.." && pwd)
case $resource in https://*/mcp) ;; *) echo "MCP_RESOURCE should look like https://HOST/mcp" >&2; exit 2 ;; esac

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
(cd "$here" && tar -cf - --exclude node_modules issuer/src issuer/package.json issuer/bun.lock issuer/tsconfig.json) | tar -xf - -C "$stage"
cp "$here/deploy/systemd/workdone-issuer.service" "$stage/"
cp "$here/deploy/Caddyfile.issuer" "$stage/"

ssh "$host" "rm -rf /tmp/wd-issuer && mkdir /tmp/wd-issuer" 
tar -cf - -C "$stage" . | ssh "$host" "tar -xf - -C /tmp/wd-issuer"
ssh "$host" "RESOURCE='$resource' NAME='$name' sh -s" <<'REMOTE'
set -eu
src=/tmp/wd-issuer
sudo rm -rf /opt/workdone-issuer.new
sudo mkdir /opt/workdone-issuer.new
sudo cp -r "$src/issuer/." /opt/workdone-issuer.new/
sudo chown -R root:root /opt/workdone-issuer.new
(cd /opt/workdone-issuer.new && sudo /usr/local/bin/bun install --frozen-lockfile --production >/dev/null)
id workdone-issuer >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/workdone-issuer --shell /usr/sbin/nologin workdone-issuer
sudo install -d -m 700 -o workdone-issuer -g workdone-issuer /var/lib/workdone-issuer
if ! sudo test -e /var/lib/workdone-issuer/signing-key.json; then
  umask 077
  openssl rand -base64 24 | tr -d '\n=+/' | head -c 28 > "$HOME/workdone-issuer-password"
  printf '\n' >> "$HOME/workdone-issuer-password"
  sudo -u workdone-issuer /usr/local/bin/bun /opt/workdone-issuer.new/src/setup.ts /var/lib/workdone-issuer < "$HOME/workdone-issuer-password"
fi
[ -d /opt/workdone-issuer ] && sudo mv /opt/workdone-issuer /opt/workdone-issuer.old-$(date +%Y%m%d%H%M%S)
sudo mv /opt/workdone-issuer.new /opt/workdone-issuer

sudo install -d -m 750 -o root -g workdone-issuer /etc/workdone-issuer
sudo sh -c "umask 027; cat > /etc/workdone-issuer/env" <<EOF2
ISSUER_URL=https://$NAME
MCP_RESOURCE=$RESOURCE
OWNER_SUBJECT=owner
ISSUER_HOST=172.24.0.1
ISSUER_PORT=8790
EOF2
sudo chgrp workdone-issuer /etc/workdone-issuer/env
sudo install -m 644 "$src/workdone-issuer.service" /etc/systemd/system/workdone-issuer.service
sudo systemctl daemon-reload
sudo systemctl enable workdone-issuer >/dev/null 2>&1
sudo systemctl restart workdone-issuer
sleep 2
curl -fsS http://172.24.0.1:8790/healthz && echo " issuer up on the bridge"

# Public TLS: a site block in the rustdesk Caddy. Back up, validate, reload; restore on failure.
cf=/opt/docker/rustdesk/Caddyfile
if ! sudo grep -q "^$NAME {" "$cf"; then
  sudo cp -p "$cf" "$cf.bak-issuer-$(date +%Y%m%d%H%M%S)"
  { echo; sed "s/^issuer.example.com {/$NAME {/" "$src/Caddyfile.issuer" | grep -v '^#'; } | sudo tee -a "$cf" >/dev/null
  if sudo docker exec rustdesk-caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 && sudo docker exec rustdesk-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    echo "caddy reloaded"
  else
    echo "caddy validation or reload failed; restoring the old Caddyfile" >&2
    sudo sh -c "cp -p \$(ls -t $cf.bak-issuer-* | head -1) $cf"
    sudo docker exec rustdesk-caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
    exit 1
  fi
fi
rm -rf "$src"
echo "password is in ~/workdone-issuer-password on this machine (mode 600). JWKS for the MCP: /var/lib/workdone-issuer/jwks.json"
REMOTE
for i in 1 2 3 4 5 6; do
  if curl -fsS "https://$name/.well-known/openid-configuration" | grep -q '"S256"'; then echo "public discovery OK: https://$name"; exit 0; fi
  sleep 5
done
echo "issuer is up but https://$name did not answer yet (Caddy may still be getting its certificate)" >&2
exit 1
