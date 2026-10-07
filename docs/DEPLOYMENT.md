# Deploying WorkDone on new machines

Runbook for deploying the Herdr ↔ ChatGPT bridge (WorkDone) from scratch, on someone else's machines. It is written for a coding agent with access to this repository and to a terminal on the workstation, which asks the human only for what needs their account or their decision.

```text
ChatGPT → MCP app (Tunnel connection) → OpenAI Secure MCP Tunnel
  → tunnel-client on the server → MCP on the server's 127.0.0.1:8787
  → OpenSSH over Tailscale → forced command (gateway) on the workstation → Herdr socket
  → OpenSSH to 127.0.0.1    → the server's own gateway (optional)
  → OpenSSH over Tailscale → gateways on other machines (optional, scripts/add-machine.sh)
```

Three roles:

- **Workstation** (macOS or Linux): where Herdr and the agents run. It carries the gateway. The scripts are launched from here.
- **Server** (Linux with systemd, always on): the MCP, the OpenAI tunnel or tunnels and, if native Events are turned on, the OAuth issuer.
- **Extra machines** (optional): any computer with Bun, Herdr and sshd on the tailnet.

Related documents, which this one does not repeat:

- `README.md`: tools, capabilities, agent CLIs and models, notifications, where the security checks live.
- `docs/INSTALL_AND_SETUP.md`: the original runbook and its security constraints. It uses Node and some old names. Where it differs, this document and the code win.
- `docs/mcp-events.md` and `issuer/README.md`: native Events and the OAuth issuer.
- `docs/chatgpt-link.md`: the link card, `tell`, the permission policies and the approval card.

---

## Contents

0. [Conventions](#0-conventions)
1. [Values to fill in before starting](#1-values-to-fill-in-before-starting)
2. [Requirements per machine](#2-requirements-per-machine)
3. [Phase 1: gateway on the workstation](#3-phase-1-gateway-on-the-workstation)
4. [Phase 2: server base and bridge key](#4-phase-2-server-base-and-bridge-key)
5. [Phase 3: authorized_keys on the workstation](#5-phase-3-authorized_keys-on-the-workstation)
6. [Phase 4: Tailscale policy](#6-phase-4-tailscale-policy)
7. [Phase 5: pin the host key and negative tests](#7-phase-5-pin-the-host-key-and-negative-tests)
8. [Phase 6: MCP service on the server](#8-phase-6-mcp-service-on-the-server)
9. [Phase 7: verified tunnel-client](#9-phase-7-verified-tunnel-client)
10. [Phase 8: tunnel and API key in OpenAI Platform](#10-phase-8-tunnel-and-api-key-in-openai-platform)
11. [Phase 9: configure and start the tunnel](#11-phase-9-configure-and-start-the-tunnel)
12. [Phase 10: app and plugin in ChatGPT](#12-phase-10-app-and-plugin-in-chatgpt)
13. [Phase 11: acceptance tests](#13-phase-11-acceptance-tests)
14. [Phase 12 (optional): the server as a machine, and phone notifications](#14-phase-12-optional-the-server-as-a-machine-and-phone-notifications)
15. [Phase 13 (optional): extra machines](#15-phase-13-optional-extra-machines)
16. [Phase 14 (optional): capabilities and agent models](#16-phase-14-optional-capabilities-and-agent-models)
17. [Phase 15 (optional, experimental): native Events and OAuth issuer](#17-phase-15-optional-experimental-native-events-and-oauth-issuer)
18. [Daily operation and updates](#18-daily-operation-and-updates)
19. [Rotate the tunnel API key](#19-rotate-the-tunnel-api-key)
20. [Known failures and fixes](#20-known-failures-and-fixes)
21. [Hardcoded values in the scripts and how to adapt them](#21-hardcoded-values-in-the-scripts-and-how-to-adapt-them)
22. [Uninstall](#22-uninstall)

---

## 0. Conventions

- **[AGENT]**: the agent runs it.
- **[HUMAN]**: the person who owns the accounts does it. These are steps in OpenAI Platform, in ChatGPT, in the Tailscale admin console, in system settings, and any step that touches a secret. The agent tells them exactly what to do and waits for them to confirm.
- If the agent's permission classifier blocks a step (writing remote `known_hosts`, copying the repo to the server, starting the tunnel, deploying), do not work around it: give the command to the human to run.
- Commands marked "on the workstation" run from the root of the cloned repo (`<REPO_DIR>`). Commands marked "on the server" run after `ssh <SERVER_SSH_ALIAS>`.
- Before editing any existing file, make a `.bak-YYYYMMDDhhmmss` copy. The repo scripts already do this for what they touch.

### Secrets

There are three: the tunnel runtime API key (`sk-…`), the OAuth issuer password (phase 15 only) and the SSH private keys. Rules:

- The agent never prints, reads, copies or pastes a secret. It does not read the clipboard either, not even to check a prefix.
- SSH private keys are generated on the machine that uses them and never leave it. Only the public key travels.
- The API key reaches the server through a hidden prompt or through a pipe from the clipboard that the human runs in their own terminal (phase 9). It reaches `tunnel-client` through the environment, never through arguments visible in `ps`.
- Never paste a secret into the chat with the agent.

---

## 1. Values to fill in before starting

The agent fills in this table first (in its notes, not in the repo) and uses it throughout the document. None of these values is secret, but they are not committed either.

| Placeholder | What it is | How to get it |
| --- | --- | --- |
| `<REPO_DIR>` | Path of the cloned repo on the workstation | `pwd` at the root of the clone |
| `<WORKSTATION_OS>` | `macos` or `linux` | `uname -s` (`Darwin` = macOS) |
| `<WORKSTATION_USER>` | Workstation user | `whoami` |
| `<WORKSTATION_HOME>` | Absolute home directory on the workstation | `printf '%s\n' "$HOME"` |
| `<WORKSTATION_TAILNET_HOST>` | MagicDNS name of the workstation | `tailscale status --json \| jq -r .Self.DNSName \| sed 's/\.$//'` |
| `<WORKSTATION_TAILSCALE_IP>` | Tailscale IP of the workstation | `tailscale ip -4` |
| `<WORKSTATION_MACHINE>` | Workstation name for ChatGPT (the `machine` parameter) | Your choice. `mac` fits the skill and the current examples. On Linux it can be something else (see §12.2) |
| `<HERDR_SOCKET>` | Herdr socket on the workstation | `herdr status server` (usually `~/.config/herdr/herdr.sock`) |
| `<BUN_VERSION>` | Bun version on the workstation | `bun --version` |
| `<SERVER_SSH_ALIAS>` | SSH alias of the server in the workstation's `~/.ssh/config` | `grep -i '^Host ' ~/.ssh/config`, then check with `ssh <alias> true` |
| `<SERVER_USER>` | User the workstation logs into the server as | `ssh <SERVER_SSH_ALIAS> whoami` |
| `<SERVER_TAILSCALE_IP>` | Tailscale IP of the server | `ssh <SERVER_SSH_ALIAS> tailscale ip -4` |
| `<SERVER_ARCH>` | `amd64` or `arm64` | `ssh <SERVER_SSH_ALIAS> uname -m` (`x86_64` = amd64, `aarch64` = arm64) |
| `<ALLOWED_ROOT>` | Projects folder on the workstation that ChatGPT will be able to see | Ask the human. Neither `/` nor `~` (the gateway rejects them) |
| `<TUNNEL_CLIENT_VERSION>` | `openai/tunnel-client` release | `gh release list -R openai/tunnel-client --limit 3` |
| `<TUNNEL_ID>` | Tunnel ID (`tunnel_` + 32 hex) | OpenAI Platform gives it in phase 8 [HUMAN] |
| `<APP_ID>` | App ID in ChatGPT (`asdk_app_…`) | App settings URL in phase 10, without the `plugin_` prefix |

Only for phase 15 (Events):

| Placeholder | What it is | How to get it |
| --- | --- | --- |
| `<AUTH_PORT>` | Loopback port of the MCP's OAuth listener | A free one on the server: `ss -ltn`. The current scripts use `8789` |
| `<ISSUER_HOST>` | Public DNS name of the server for the issuer | The human's DNS pointing at the server's public IP |
| `<MCP_RESOURCE>` | Canonical URL of the OAuth-protected MCP resource | `https://<ISSUER_HOST>/mcp` if you use the public route from §17 |

Connectivity check before going on (on the server):

```bash
tailscale ping -c 1 <WORKSTATION_TAILSCALE_IP>
nc -z -w 3 <WORKSTATION_TAILSCALE_IP> 22 && echo ssh-ok
```

Expected: `pong from …` and `ssh-ok`. If not, stop here.

---

## 2. Requirements per machine

### Workstation

- Herdr installed and its server running. `herdr --version` and `herdr status server` respond.
- Bun at `~/.bun/bin/bun` (or at another path, passed with `BUN=`).
- `jq`, `git`, `ssh`, `zip`, `gh` (to verify `tunnel-client`).
- Tailscale connected.
- The system sshd listening on port 22 of the tailnet, **not Tailscale SSH**. With Tailscale SSH, Tailscale's SSH server answers port 22 and the `authorized_keys` restrictions (forced command, `from=`) are not applied.

  ```bash
  tailscale debug prefs | grep RunSSH
  ```

  Expected: `"RunSSH": false`. If it shows `true`, **[HUMAN]** decides: turn it off, or use another port with a normal sshd (see `docs/INSTALL_AND_SETUP.md`, phase 0). Do not turn it off without permission.

- macOS: "Remote Login" turned on **[HUMAN]** (System Settings > General > Sharing > Remote Login). `launchctl` may show `com.openssh.sshd` as "not running": that is normal, launchd starts sshd per connection.
- macOS, optional: for the gateway to read `~/Downloads`, `~/Documents` or `~/Desktop`, **[HUMAN]** turns on "Allow full disk access for remote users" in the same panel. It affects every SSH session, not just the bridge.

### Server

- Linux with systemd (tested on Debian 12). Passwordless `sudo` for `<SERVER_USER>`: `scripts/deploy-ovh.sh`, `scripts/add-machine.sh` and `scripts/deploy-issuer.sh` run `sudo` in sessions without a terminal.
- Tailscale connected, in TUN mode (the normal one). In userspace mode sshd does not see the client's tailnet IP and `from=` stops working.
- `curl`, `jq`, `ssh`, `python3` or `unzip`, `ss`.
- Bun `<BUN_VERSION>` at `/usr/local/bin/bun`, the same version as the workstation (see phase 2).
- Only if the server will also be a working machine (phase 12): Herdr with its server running for `<SERVER_USER>`, sshd listening on `127.0.0.1:22`, and an existing `~/.ssh/authorized_keys`.
- Only for phase 15: Node 24 at `/usr/bin/node`, public ports 80 and 443, and a TLS proxy (Caddy).
- Nothing this runbook installs listens on a public interface, except the issuer and the `/mcp` route from phase 15.

### Verification

On the workstation:

```bash
herdr --version && herdr status server
~/.bun/bin/bun --version
tailscale debug prefs | grep RunSSH
```

On the server:

```bash
cat /etc/os-release | head -3; systemctl --version | head -1
sudo -n true && echo sudo-ok
ss -ltn | grep -E ':(8787|8080|8081|8789|8790)\b' || echo ports-free
```

Expected: versions printed, `"RunSSH": false`, `sudo-ok`, `ports-free`. If a port is taken, note it and adapt (see §21).

---

## 3. Phase 1: gateway on the workstation

The gateway is the forced command of the bridge key: it reads one JSON request per line on stdin and answers with one line on stdout. It runs the security checks (allowed roots, IDs, capabilities) on the workstation itself. Details in `README.md`, "Where the security checks live".

**[AGENT]** On the workstation:

```bash
cd <REPO_DIR>
bun install && (cd mcp && bun install)
bun run check                 # tsc + all the tests
scripts/install-gateway.sh    # BUN=/path/to/bun if it is not at ~/.bun/bin/bun
```

`install-gateway.sh` copies `gateway/*.ts` and the launcher to `~/.local/libexec/herdr-chatgpt/` (700/600), writes `bun-path`, installs `workdone-tell` in `~/.local/bin` and, if it does not exist, creates `~/.config/herdr-chatgpt/gateway.json` from `config/mac-gateway.example.json`. It never overwrites an existing `gateway.json`.

### Edit `gateway.json`

Backup first. Minimal changes to the example:

- `allowedRoots`: `["<ALLOWED_ROOT>"]`. Each root must exist. `/` and `~` are rejected.
- `repos`: `{}` or the real repos inside the roots. A repo outside the roots makes loading fail.
- `worktreeRoot`: `null` in the example, or a folder inside the roots (checked whenever the config loads: outside them it fails to load). New worktrees go in `<worktreeRoot>/<repo key>/<branch>` (the repo's key in `repos`, so two repos with the same folder name don't collide) instead of next to their repo (`<repo>.worktrees/<branch>`). Set it when a repo is itself an allowed root: the folder next to it is then outside the roots, and its worktrees are refused with `path_not_allowed`.
- `herdrSocketPath`: `<HERDR_SOCKET>` if it is not the default one.
- `agentModels`: the example points at `~/.config/herdr-chatgpt/agent-models.json`. **If that file does not exist, the gateway does not start.** Either delete the key for now, or generate the file (§16.2).
- `agentKinds`: optional. Without it the gateway offers every agent CLI installed on the machine (`claude`, `codex`, `cursor`, `opencode`, `pi` and the other kinds Herdr knows). List them to offer fewer.
- On Linux: `shell` (for example `/usr/bin/zsh` or `/bin/bash`) and `extraPath` (remove `/opt/homebrew/bin`).
- All `allow*` capabilities stay `false` in the initial install.

```bash
cp -p ~/.config/herdr-chatgpt/gateway.json ~/.config/herdr-chatgpt/gateway.json.bak-$(date +%Y%m%d%H%M%S)
# edit with jq or with the editor; minimal example:
jq --arg root '<ALLOWED_ROOT>' '.allowedRoots = [$root] | .repos = {} | del(.agentModels)' \
  ~/.config/herdr-chatgpt/gateway.json > /tmp/gw.json && install -m 600 /tmp/gw.json ~/.config/herdr-chatgpt/gateway.json && rm /tmp/gw.json
```

The gateway rereads `gateway.json` on every call, so there is nothing to restart.

### Verification

```bash
L=~/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh
printf '%s\n' \
  '{"id":"1","op":"bridge_status","params":{}}' \
  '{"id":"2","op":"overview","params":{}}' \
  '{"id":"3","op":"get_agent","params":{"target":"--zzbogus"}}' \
  '{"id":"4","op":"run_command_in_pane","params":{"pane_id":"x:p1","command":"id"}}' \
  '{"id":"5","op":"remove_worktree","params":{"workspace_id":"x"}}' \
  '{"id":"6","op":"nope","params":{}}' \
  'not json' | env -i HOME="$HOME" "$L" | jq -c '{id, ok, code: .error.code}'
```

Expected:

- 1 and 2 with `ok: true`. The full response to 1 includes `herdr_version` and `allowed_roots`.
- 3 `invalid_params`.
- 4 and 5 `capability_disabled`.
- 6 `unknown_operation`.
- the last one `invalid_json`.

Also, `overview` must not list agents whose directory is outside `<ALLOWED_ROOT>`: they show up as "not found". Every call is logged in `~/.local/state/herdr-chatgpt/audit.jsonl`.

---

## 4. Phase 2: server base and bridge key

### Bun with the same version as the workstation

The lockfile is written by the workstation's Bun version. With another version, `bun install --frozen-lockfile` fails with `UnknownLockfileVersion`. Install the official release in `/usr/local/bin`, verified, without touching a user Bun that may already exist.

**[AGENT]** On the server (`bun-linux-x64.zip` for amd64, `bun-linux-aarch64.zip` for arm64):

```bash
V=<BUN_VERSION>; A=bun-linux-x64
cd "$(mktemp -d)"
curl -fsSLO "https://github.com/oven-sh/bun/releases/download/bun-v$V/$A.zip"
curl -fsSLO "https://github.com/oven-sh/bun/releases/download/bun-v$V/SHASUMS256.txt"
grep " $A.zip\$" SHASUMS256.txt | sha256sum -c -
python3 -c "import zipfile; zipfile.ZipFile('$A.zip').extractall('.')"
sudo install -m 755 -o root -g root "$A/bun" /usr/local/bin/bun
/usr/local/bin/bun --version
```

Expected: `…zip: OK` and the same version as `<BUN_VERSION>`.

### Service user, directories and key

```bash
id herdr-mcp 2>/dev/null || sudo useradd --system --home /var/lib/herdr-mcp --create-home --shell /usr/sbin/nologin herdr-mcp
sudo install -d -m 750 -o root -g herdr-mcp /etc/herdr-mcp
sudo install -d -m 700 -o herdr-mcp -g herdr-mcp /etc/herdr-mcp/ssh
sudo test -e /etc/herdr-mcp/ssh/id_ed25519 || \
  sudo -u herdr-mcp ssh-keygen -q -t ed25519 -a 100 -N "" -C herdr-chatgpt-bridge -f /etc/herdr-mcp/ssh/id_ed25519
```

The private key never leaves the server. It is a dedicated key: no personal key is used.

### Verification

```bash
sudo ls -l /etc/herdr-mcp/ssh/
sudo ssh-keygen -lf /etc/herdr-mcp/ssh/id_ed25519.pub
```

Expected: `id_ed25519` with `-rw------- herdr-mcp`, and a fingerprint `SHA256:… herdr-chatgpt-bridge (ED25519)`.

---

## 5. Phase 3: authorized_keys on the workstation

The line ends up like this:

```text
from="<SERVER_TAILSCALE_IP>",restrict,command="<WORKSTATION_HOME>/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh" ssh-ed25519 AAAA… herdr-chatgpt-bridge
```

`from=` accepts the key only from the server's Tailscale IP, `restrict` removes PTY, forwarding and agent forwarding, and `command=` forces the gateway. The launcher ignores `SSH_ORIGINAL_COMMAND` and audits it as `ssh_command_ignored`.

**[AGENT]** On the workstation:

```bash
install -d -m 700 ~/.ssh
[ -e ~/.ssh/authorized_keys ] && cp -p ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-$(date +%Y%m%d%H%M%S)
ssh <SERVER_SSH_ALIAS> 'sudo cat /etc/herdr-mcp/ssh/id_ed25519.pub' > /tmp/bridge.pub
scripts/render-authorized-key.sh <SERVER_TAILSCALE_IP> \
  "$HOME/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh" /tmp/bridge.pub >> ~/.ssh/authorized_keys
rm /tmp/bridge.pub
chmod 600 ~/.ssh/authorized_keys
```

The launcher path cannot contain spaces or quotes (the script rejects them).

### Verification

```bash
tail -1 ~/.ssh/authorized_keys | cut -c1-120
diff <(sed '$d' ~/.ssh/authorized_keys) "$(ls -t ~/.ssh/authorized_keys.bak-* | head -1)" && echo previous-keys-intact
```

Expected: the line starts with `from="<SERVER_TAILSCALE_IP>",restrict,command="/…/herdr-gateway-launcher.sh"`, and `previous-keys-intact` (if there was a previous file).

---

## 6. Phase 4: Tailscale policy

**[HUMAN]** Open the tailnet policy in the Tailscale admin console (Access controls) and read it. Do not replace it.

- If it is the default policy (`"src": ["*"], "dst": ["*:*"]`), any device reaches any port. Adding a specific rule restricts nothing while that one exists. Restricting for real means removing the "accept all", and that affects every device on the tailnet: it is the human's decision, not the agent's.
- If there are already specific rules, add the minimal one: the server reaches port 22 on the workstation (and on each extra machine). Use tags or existing selectors, whatever does not widen other access. Example in `docs/INSTALL_AND_SETUP.md`, phase 3.

Even with an open policy, access stays limited by `from=` on the key, the forced command, and the MCP listening only on loopback.

### Verification

On the server:

```bash
nc -z -w 3 <WORKSTATION_TAILSCALE_IP> 22 && echo ssh-ok
```

Expected: `ssh-ok`.

---

## 7. Phase 5: pin the host key and negative tests

Never use `StrictHostKeyChecking=no`. Take the workstation's host key through a trusted local path (reading it on the workstation itself) and compare it with the one the server sees over the network.

**[AGENT]** On the workstation:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
ssh <SERVER_SSH_ALIAS> 'ssh-keyscan -t ed25519 <WORKSTATION_TAILNET_HOST> 2>/dev/null | ssh-keygen -lf -'
```

The two fingerprints must match. If they do not, stop and tell the human.

With matching fingerprints, write `known_hosts` on the server with the MagicDNS name and the IP:

```bash
echo "<WORKSTATION_TAILNET_HOST>,<WORKSTATION_TAILSCALE_IP> $(awk '{print $1" "$2}' /etc/ssh/ssh_host_ed25519_key.pub)" \
  | ssh <SERVER_SSH_ALIAS> 'sudo -u herdr-mcp tee /etc/herdr-mcp/ssh/known_hosts >/dev/null && sudo chmod 644 /etc/herdr-mcp/ssh/known_hosts'
```

The agent's permission classifier may block this step. In that case the human runs it.

### Tests from the server as `herdr-mcp`

On the server. These are the same `ssh` options the service uses:

```bash
s() { sudo -u herdr-mcp /usr/bin/ssh -F /dev/null -i /etc/herdr-mcp/ssh/id_ed25519 \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/etc/herdr-mcp/ssh/known_hosts -o GlobalKnownHostsFile=/dev/null \
  -o ForwardAgent=no -o ClearAllForwardings=yes -o RequestTTY=no "$@"; }
T=<WORKSTATION_USER>@<WORKSTATION_TAILNET_HOST>
B='{"id":"1","op":"bridge_status","params":{}}'

echo "$B" | s -T "$T" | jq -c '{ok, herdr: .result.herdr_version}'                  # 1
echo "$B" | s -T "$T" 'id; cat ~/.ssh/authorized_keys' | jq -c '{ok}'                # 2
s -T "$T" </dev/null; echo "exit $?"                                                  # 3
echo 'uname -a' | s -T "$T" | jq -c .error.code                                       # 4
echo '{"id":"1","op":"nope","params":{}}' | s -T "$T" | jq -c .error.code             # 5
echo '{"id":"1","op":"run_command_in_pane","params":{"pane_id":"x:p1","command":"id"}}' | s -T "$T" | jq -c .error.code   # 6
sudo -u herdr-mcp /usr/bin/ssh -F /dev/null -i /etc/herdr-mcp/ssh/id_ed25519 -o BatchMode=yes \
  -o UserKnownHostsFile=/etc/herdr-mcp/ssh/known_hosts -tt "$T" </dev/null 2>&1 | head -2   # 7
(timeout 6 sudo -u herdr-mcp /usr/bin/ssh -F /dev/null -i /etc/herdr-mcp/ssh/id_ed25519 -o BatchMode=yes \
  -o UserKnownHostsFile=/etc/herdr-mcp/ssh/known_hosts -T -N -L 12345:127.0.0.1:22 "$T" &
  sleep 2; nc -w 2 127.0.0.1 12345 </dev/null; wait) 2>&1 | grep -i prohibited             # 8
```

| # | Expected |
| --- | --- |
| 1 | `{"ok":true,"herdr":"…"}` |
| 2 | `{"ok":true}`: the gateway runs and the requested command is ignored. On the workstation, `audit.jsonl` has a `ssh_command_ignored` entry |
| 3 | error `empty_input`, `exit 65` |
| 4 | `"invalid_json"` |
| 5 | `"unknown_operation"` |
| 6 | `"capability_disabled"` |
| 7 | `PTY allocation request failed on channel 0` |
| 8 | the forward fails (`administratively prohibited`) and `nc` does not connect |

Before the host key is pinned, every call fails with `Host key verification failed.`: that is the correct behavior.

---

## 8. Phase 6: MCP service on the server

### Copy the code

The server may not have `rsync`. Copy with `tar` over `ssh`, as the scripts do.

**[AGENT]** On the workstation:

```bash
COPYFILE_DISABLE=1 tar -C <REPO_DIR> --no-xattrs --exclude=node_modules --exclude=.git --exclude=dist -czf - . |
  ssh <SERVER_SSH_ALIAS> 'rm -rf ~/herdr-chatgpt-bridge-staging && mkdir -m 700 ~/herdr-chatgpt-bridge-staging && tar -C ~/herdr-chatgpt-bridge-staging -xzf -'
```

On the server:

```bash
sudo rm -rf /opt/herdr-chatgpt-bridge
sudo cp -r ~/herdr-chatgpt-bridge-staging /opt/herdr-chatgpt-bridge
sudo chown -R root:root /opt/herdr-chatgpt-bridge
cd /opt/herdr-chatgpt-bridge/mcp
sudo /usr/local/bin/bun install --frozen-lockfile
sudo /usr/local/bin/bun test 2>&1 | tail -3
```

No `--production`: the MCP tests use a dev dependency. Expected: the tests end with `0 fail`.

### Configuration `/etc/herdr-mcp/ovh.json`

The file name is fixed (the unit and the scripts use it). The key inside `machines` is the name ChatGPT passes as `machine`.

```bash
sudo tee /etc/herdr-mcp/ovh.json >/dev/null <<'EOF'
{
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "machines": {
    "<WORKSTATION_MACHINE>": {
      "binary": "/usr/bin/ssh",
      "user": "<WORKSTATION_USER>",
      "host": "<WORKSTATION_TAILNET_HOST>",
      "port": 22,
      "identityFile": "/etc/herdr-mcp/ssh/id_ed25519",
      "knownHostsFile": "/etc/herdr-mcp/ssh/known_hosts",
      "connectTimeoutSeconds": 10
    }
  },
  "defaultMachine": "<WORKSTATION_MACHINE>",
  "requestTimeoutMs": 130000
}
EOF
sudo chown root:herdr-mcp /etc/herdr-mcp/ovh.json
sudo chmod 640 /etc/herdr-mcp/ovh.json
```

Loading fails if `listen.host` is not loopback or if `user`/`host` start with `-` or contain odd characters. `notify` is added in phase 12.

### Units

```bash
sudo install -m 644 /opt/herdr-chatgpt-bridge/deploy/systemd/herdr-mcp.service /etc/systemd/system/
sudo install -m 644 /opt/herdr-chatgpt-bridge/deploy/systemd/openai-herdr-tunnel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now herdr-mcp.service
```

The tunnel unit is installed now but not enabled: the phase 9 script does that. `herdr-mcp.service` runs as `herdr-mcp`, with `ProtectSystem=strict` and `IPAddressDeny=any` plus `IPAddressAllow=localhost 100.64.0.0/10 fd7a:115c:a1e0::/48`: it only talks to loopback and the tailnet.

### Verification

On the server:

```bash
systemctl is-active herdr-mcp
curl -s http://127.0.0.1:8787/healthz; echo
ss -ltnp | grep 8787
mcp() { curl -s -X POST 127.0.0.1:8787/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d "$1"; }
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq '.result.tools | length'
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bridge_status","arguments":{}}}' |
  jq -r '.result.content[0].text' | jq -c 'to_entries[] | {machine: .key, herdr: .value.herdr_version, error: .value.error.code}'
```

On the workstation:

```bash
nc -z -w 3 <SERVER_TAILSCALE_IP> 8787 && echo OPEN || echo closed
```

Expected:

- `active`
- `{"ok":true,"service":"herdr-mcp"}`
- the listener is `127.0.0.1:8787`, never `0.0.0.0` or `[::]`
- a number of tools greater than zero (it changes with the version)
- one line per machine with `herdr` and `error: null`
- `closed` from the workstation

If `bridge_status` returns `error`, check `sudo journalctl -u herdr-mcp -n 50 --no-pager` and repeat the phase 5 tests.

---

## 9. Phase 7: verified tunnel-client

Only the official `openai/tunnel-client` binary, with checksum and provenance verified. Download and verify it on the workstation (it has `gh`) and copy it to the server.

**[AGENT]** On the workstation, in a temporary directory:

```bash
V=<TUNNEL_CLIENT_VERSION>; ARCH=<SERVER_ARCH>
gh release view $V -R openai/tunnel-client --json assets --jq '.assets[].name'   # check the names
gh release download $V -R openai/tunnel-client \
  -p "tunnel-client-$V-linux-$ARCH.zip" -p SHA256SUMS.txt -p "tunnel-client-$V-provenance.sigstore.json"
SHA=$(gh api repos/openai/tunnel-client/git/ref/tags/$V --jq .object.sha)
grep "tunnel-client-$V-linux-$ARCH.zip\$" SHA256SUMS.txt | shasum -a 256 -c -
gh attestation verify "tunnel-client-$V-linux-$ARCH.zip" \
  --bundle "tunnel-client-$V-provenance.sigstore.json" \
  --repo openai/tunnel-client \
  --signer-workflow openai/tunnel-client/.github/workflows/release.yml \
  --source-ref "refs/tags/$V" --source-digest "$SHA" --signer-digest "$SHA" \
  --predicate-type https://slsa.dev/provenance/v1 --deny-self-hosted-runners
scp "tunnel-client-$V-linux-$ARCH.zip" <SERVER_SSH_ALIAS>:/tmp/
```

If `SHA256SUMS.txt` lists more than one zip for that architecture (for example a `runtime` variant), the `grep` must keep only the one you downloaded.

On the server:

```bash
cd /tmp && sha256sum tunnel-client-<TUNNEL_CLIENT_VERSION>-linux-<SERVER_ARCH>.zip   # same as on the workstation
rm -rf tc-x && python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall("tc-x")' tunnel-client-<TUNNEL_CLIENT_VERSION>-linux-<SERVER_ARCH>.zip
sudo install -d -m 755 /opt/tunnel-client
sudo cp -r tc-x/. /opt/tunnel-client/
sudo chown -R root:root /opt/tunnel-client
sudo chmod 755 /opt/tunnel-client/tunnel-client
/opt/tunnel-client/tunnel-client --version
```

The zip also contains `cloudflared`. It is not used unless you pass `--cloudflared.*` options, which this deployment does not turn on.

### Verification

Expected: `…zip: OK`, `gh attestation verify` exiting 0, the same sha256 on both machines, and `tunnel-client --version` showing the version and the tag's commit.

---

## 10. Phase 8: tunnel and API key in OpenAI Platform

All **[HUMAN]**. The agent gives these instructions and waits for the two non-secret values: `<TUNNEL_ID>` and confirmation that the key has been created and copied.

### Tunnel

At `https://platform.openai.com/settings/organization/tunnels` → "Create tunnel":

| Field | Value |
| --- | --- |
| Name | A descriptive one, for example `workdone-mcp` |
| Description | Optional, for example "Herdr MCP on my server (127.0.0.1:8787)" |
| Organizations | The organization of the API key |
| ChatGPT workspaces | **The same ChatGPT workspace or account WorkDone will be used in** |

If the list does not refresh after "Create", reload the page. Write down `<TUNNEL_ID>`.

If the person has several ChatGPT accounts (personal and work), tick the one they actually use. If the tunnel ends up in another one, ChatGPT will say "No tunnels yet". After saving a workspace change, ChatGPT takes about 30 seconds to offer the tunnel.

### Runtime API key

At `https://platform.openai.com/settings/organization/api-keys` → "Create new secret key":

| Field | Value |
| --- | --- |
| Name | For example `workdone-tunnel-runtime` |
| Permissions | **Restricted** |
| Permission granted | **Tunnels: Read + Use** |
| Other permissions | None |
| Expiration | The human's decision. With no expiration, the bridge does not break every month. With an expiration, it has to be rotated (§19) before it expires |

Never an "All" key or an admin key for the daemon.

The human clicks "Copy" themselves. A click from browser automation may not reach the system clipboard, and then something else gets pasted. Do not paste the key into the chat.

---

## 11. Phase 9: configure and start the tunnel

`scripts/ovh-setup-tunnel.sh` (already copied to `/opt/herdr-chatgpt-bridge/scripts/`):

1. reads the key from a hidden prompt or from stdin;
2. checks its shape without printing it (starts with `sk-`, no spaces or quotes) and, if it does not match, exits with "nothing written";
3. backs up the previous `tunnel.env` and writes `/etc/herdr-mcp/tunnel.env` (600, `herdr-mcp`);
4. runs `tunnel-client init --sample sample_mcp_remote_no_auth --profile herdr-mcp …` and `doctor` as `herdr-mcp`;
5. enables and restarts `openai-herdr-tunnel.service` and shows `/readyz`.

**[HUMAN]** in their own terminal on the workstation, in one of these two ways:

```bash
# A) hidden prompt: paste the key when asked
ssh -t <SERVER_SSH_ALIAS> 'sudo sh /opt/herdr-chatgpt-bridge/scripts/ovh-setup-tunnel.sh <TUNNEL_ID>'

# B) from the clipboard (macOS), and clear it afterwards
pbpaste | ssh <SERVER_SSH_ALIAS> 'sudo sh /opt/herdr-chatgpt-bridge/scripts/ovh-setup-tunnel.sh <TUNNEL_ID>'; pbcopy </dev/null
```

On Linux, form B is `wl-paste | ssh …; wl-copy --clear` (Wayland) or `xclip -selection clipboard -o | ssh …` (X11). Form B needs passwordless `sudo` on the server, because stdin carries the key.

The agent runs neither of them: reading the clipboard or receiving the key means materializing a credential.

### Verification

**[AGENT]** on the server:

```bash
systemctl is-active openai-herdr-tunnel
curl -s 127.0.0.1:8080/readyz; echo
curl -s 127.0.0.1:8080/api/status | jq .
sudo journalctl -u openai-herdr-tunnel -n 30 --no-pager -o cat | grep -E 'started|initialized|error' | tail -5
```

Expected: `active`, `ready`, the `main` channel with `"enabled": true`, and a `tunnel-client started` line in the journal. If `journalctl` shows `control plane API key is malformed` with restarts every 5 s, the key that went in was not the right one: repeat phase 9 with the key copied by hand.

The profile is at `/etc/herdr-mcp/tunnel-client/herdr-mcp.yaml` and does not contain the key (`api_key: "env:CONTROL_PLANE_API_KEY"`).

---

## 12. Phase 10: app and plugin in ChatGPT

ChatGPT has two separate objects and you need both:

| Object | What it is |
| --- | --- |
| **App** (`asdk_app_…`) | The connection through the tunnel and the MCP tools |
| **Plugin** | The `herdr-remote` skill and the link to the app. It is what you invoke with `@` |

**Do not delete the app even if it looks like a duplicate of the plugin.** Without it, the plugin says "No app tools available yet" and ChatGPT answers "No tool was defined".

### 12.1 Create the app [HUMAN]

At `https://chatgpt.com/plugins` → "+" → "Create app" → in the dialog, "Create MCP App". If the option does not appear, you may need to turn on developer mode in ChatGPT settings.

| Field | Value |
| --- | --- |
| Name | For example `WorkDone Tunnel` (different from the plugin, so they are not confused) |
| Description | For example "Connection used by the WorkDone plugin. Use the plugin, not this app." |
| Connection | **Tunnel** |
| Available tunnels | The one for `<TUNNEL_ID>` |
| Authentication | **No Auth** (this MCP has no OAuth on port 8787; the default is "OAuth") |
| "I understand and want to continue" | Ticked |

After "Create", ChatGPT shows "… is now connected". The ID appears in the app settings URL as `plugin_asdk_app_…`. **The app ID is the `asdk_app_…` part, without the `plugin_` prefix.** That is `<APP_ID>`.

### 12.2 Adapt and package the plugin [AGENT]

The plugin in the repo describes the original deployment. Before packaging it, the agent reviews with the human:

- `plugin/herdr-remote/.codex-plugin/plugin.json`: `description`, `interface.shortDescription`, `longDescription`, `developerName`, `author.name` and `defaultPrompt` name specific machines and repos. Replace them with the ones for this deployment.
- `plugin/herdr-remote/skills/herdr-remote/SKILL.md`: names the machines `mac`, `ovh` and a third one, uses a specific example repo, and has a section about a remote browser that only applies if a browser is configured in the gateway (`browser` in `gateway.json`). Adjust the machine names to the ones in `ovh.json` and remove that section if it does not apply.

Then:

```bash
cd <REPO_DIR>
cp plugin/herdr-remote/.app.json.example plugin/herdr-remote/.app.json
jq --arg id '<APP_ID>' '.apps["herdr-remote"].id = $id' plugin/herdr-remote/.app.json > /tmp/app.json && mv /tmp/app.json plugin/herdr-remote/.app.json
mkdir -p dist
(cd plugin && zip -qr -X ../dist/herdr-remote-plugin.zip herdr-remote \
  -x '*.DS_Store' -x 'herdr-remote/.gitignore' -x 'herdr-remote/.app.json.example')
unzip -l dist/herdr-remote-plugin.zip
```

`.app.json` is ignored by git: the ID belongs to that account and is not committed. Expected in `unzip -l`: `.codex-plugin/plugin.json`, `.app.json` and `skills/herdr-remote/SKILL.md`.

### 12.3 Upload and install the plugin [HUMAN]

- First time: `https://chatgpt.com/plugins` → "+" → "Upload plugin" → `dist/herdr-remote-plugin.zip`. Expected: "Import successful".
- If the error says `apps.herdr-remote.id must begin with asdk_app_, connector_, or templated_apps_`, the ID has the `plugin_` prefix: remove it and package again.
- On the plugin page, "Install plugin".
- Later versions: on the plugin page, "…" menu → **Upload new version**. "Add → Upload plugin archive" from the list creates a new plugin, and with the same zip it fails ("Couldn't add plugin").

### Verification

**[HUMAN]** In a new chat: `@<plugin name> what are my Herdr agents doing right now?`.

**[AGENT]** On the workstation:

```bash
tail -n 5 ~/.local/state/herdr-chatgpt/audit.jsonl | jq -c '{op, ok, client}'
```

Expected: ChatGPT answers with the list of agents and the audit log has new entries (`overview` or others) with `client` equal to `<SERVER_TAILSCALE_IP>`.

---

## 13. Phase 11: acceptance tests

From a new chat with the plugin. The agent checks each one in `audit.jsonl` or in the server journal.

| # | Test | Expected |
| --- | --- | --- |
| 1 | `bridge_status` | answers with the Herdr version and the roots |
| 2 | `overview` | only agents inside the allowed roots |
| 3 | Read an agent (`read_agent`) | screen text or the last response |
| 4 | Start a test agent in a throwaway folder inside the root (`spawn_agent`) and ask it for something harmless | it answers; the first prompt waits until it is `idle` |
| 5 | `run_command_in_pane` | `capability_disabled` |
| 6 | `remove_worktree` | `capability_disabled` |
| 7 | **[HUMAN]** asks for it; **[AGENT]** stops the tunnel: `sudo systemctl stop openai-herdr-tunnel` | ChatGPT loses access; no new port open (`ss -ltn` same as before) |
| 8 | `sudo systemctl start openai-herdr-tunnel` | `/readyz` returns to `ready` and ChatGPT regains access |
| 9 | `sudo systemctl restart herdr-mcp` | the tunnel restarts with it (`Requires=`), waits for the MCP's `/healthz` (`ExecStartPre`) and the channel comes back with `"enabled": true` |

When done, close the test agent and delete the throwaway folder.

---

## 14. Phase 12 (optional): the server as a machine, and phone notifications

### 14.1 Server gateway

With this, ChatGPT also controls the Herdr agents on the server, which stays on while the workstation sleeps. `scripts/deploy-ovh.sh` does it, from the workstation:

- copies the repo to the server and installs the gateway for `<SERVER_USER>` with `config/ovh-gateway.example.json` (root `~/src`, capabilities off);
- creates `/etc/herdr-mcp/ssh/id_ed25519_ovh` and adds it to `<SERVER_USER>`'s `~/.ssh/authorized_keys` with `from="127.0.0.1"` and the forced command;
- pins the server's host key for `127.0.0.1`;
- tests `bridge_status` through that key;
- deploys the MCP to `/opt/herdr-chatgpt-bridge` (the previous version stays at `/opt/herdr-chatgpt-bridge.old-<date>`);
- adds `machines.ovh` and `notify: {machine: "ovh"}` to `ovh.json` if missing, and restarts `herdr-mcp`.

Prerequisites on the server: Herdr running for `<SERVER_USER>`, an existing `~/.ssh/authorized_keys` (`touch` and `chmod 600` if not), sshd listening on `127.0.0.1:22`, `jq`, and passwordless `sudo`. **The machine name is fixed as `ovh`** (see §21).

Before running it, check `~/.config/herdr-chatgpt/gateway.json` on the server if it already exists. If not, the script creates it from the example, which has a `browser` section and a `~/src` root that you need to adjust (and `~/src` must exist).

**[AGENT]** on the workstation (if the classifier blocks it, the human runs it):

```bash
scripts/deploy-ovh.sh <SERVER_SSH_ALIAS>
```

Verification: the output ends with one line per machine, `{"machine":"<WORKSTATION_MACHINE>","herdr":"…",…}` and `{"machine":"ovh","herdr":"…",…}`, with no `error`, and with the rollback command.

### 14.2 Phone notifications

The MCP has a notifier: it watches agents that have pending work and sends a notification when they finish or stop on a question. It sends it through the gateway of `notify.machine` in `ovh.json`, which runs its `notifyCommand` with the message as the last argument. Details in `README.md`, "Notifications and offline machines".

- `notify.machine` should be a machine that is always on (the server). If it points at the workstation, notifications wait until it wakes up.
- `deploy-ovh.sh` only fills in `notifyCommand` if a notification script exists at a specific path of the author's. Otherwise, set it by hand in that machine's `gateway.json`. Any command that takes the message as its last argument works, for example `["/usr/local/bin/my-notifier", "--title", "WorkDone", "--message"]`. The human decides the channel (ntfy, Pushover, email) and puts in its credentials themselves.
- Without `notify` in `ovh.json`, there are no phone notifications.
- Do not install `scripts/install-watcher.sh` (the launchd watcher) alongside the MCP notifier: both would work on the same list. The watcher is only for a single-machine deployment with no server.

Verification:

```bash
printf '%s\n' '{"id":"1","op":"notify","params":{"message":"WorkDone test"}}' | ~/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh
```

run on the `notify.machine` machine. Expected: `{"ok":true,…"exit_code":0}` and the notification on the phone. Warn the human first: it is a real message.

---

## 15. Phase 13 (optional): extra machines

`scripts/add-machine.sh NAME SSH_ALIAS '~/folder' ...` runs from the workstation and:

- installs the gateway on the machine (all capabilities off, the config is only created if it does not exist);
- creates `/etc/herdr-mcp/ssh/id_ed25519_NAME` on the server and adds the `authorized_keys` line on the machine with `from=<SERVER_TAILSCALE_IP>` and the forced command;
- pins the machine's host key on the server, comparing the one it reads on the machine with the one `ssh-keyscan` sees from the server (if they do not match, it stops);
- adds `machines.NAME` to `ovh.json` and finishes with `scripts/deploy-ovh.sh`.

Requirements on the machine: Bun at `~/.bun/bin/bun`, Herdr server running, readable `/etc/ssh/ssh_host_ed25519_key.pub`, normal sshd (not Tailscale SSH). On the workstation, `SSH_ALIAS` must resolve to a tailnet address (`100.x` or `*.ts.net`) that the server can also reach, because the script copies host, port and user from `ssh -G SSH_ALIAS`. `NAME` matches `^[a-z][a-z0-9-]{0,15}$`. Since it finishes with `deploy-ovh.sh`, it also needs what §14.1 needs.

**[AGENT]** on the workstation:

```bash
OVH_HOST=<SERVER_SSH_ALIAS> scripts/add-machine.sh <NAME> <SSH_ALIAS> '~/src'
```

The roots go in single quotes so the workstation does not expand `~`. If the server cannot read its own Tailscale IP, pass `OVH_TAILNET_IP=<SERVER_TAILSCALE_IP>`.

Verification: the `deploy-ovh.sh` output at the end includes a line with `"machine":"<NAME>"` and its Herdr version. The last printed lines give the command to turn on capabilities on that machine. `machine` is free text in the tools, so ChatGPT does not need **Refresh tools** to see a new machine.

### Herdr on a headless Linux machine

- Manual start: `setsid nohup herdr server >~/.local/state/herdr-server.log 2>&1 &`. The repo has no unit to start Herdr after a reboot: you need to add one (a systemd user unit, a cron `@reboot`, or the system's task scheduler).
- If the Herdr server started with a minimal `PATH`, panes do not find `claude`, `codex` or `cursor-agent`. Fix without restarting Herdr: in `~/.config/herdr/config.toml`, `[terminal] default_shell = "/path/to/shell"` and `shell_mode = "login"`, then `herdr server reload-config`. New panes read the login profile.
- On some NAS devices `scp` fails. To copy a file: `ssh ALIAS 'cat > path' < file`.

---

## 16. Phase 14 (optional): capabilities and agent models

### 16.1 Capabilities

They all start off. The table of what each one opens is in `README.md`. The human turns them on, machine by machine, by editing `gateway.json`. The agent can prepare the command, but does not run it without their explicit decision. With `allowExec`, the roots stop being a limit for everything except the file tools: a command can go anywhere the user can reach.

```bash
cd ~/.config/herdr-chatgpt && b=gateway.json.bak-$(date +%Y%m%d%H%M%S) && cp -p gateway.json "$b" &&
  jq '.allowFileRead = true' "$b" > gateway.json.new && install -m 600 gateway.json.new gateway.json && rm gateway.json.new
```

Other useful switches:

- `"execInPane": true`: `exec` runs in a Herdr tab inside the user's interactive shell, with their `.zshrc`, their keychain and their ssh-agent. Without this, `exec` runs as the gateway's SSH login, and tools that keep their token in the macOS keychain (for example `gh`) fail with 401.
- `"autoApprove": false`: turns off automatic approval of menus.
- `"leases": false`: turns off per-conversation leases (not recommended with several chats at once).

Verification: `bridge_status` on that machine shows the capability in `capabilities`.

### 16.2 Agent models

ChatGPT starts agents by CLI, model and effort ("claude opus high"). The model list says which models each CLI offers, always the newest version of each family. On each machine:

```bash
bun scripts/agent-models.ts        # writes ~/.config/herdr-chatgpt/agent-models.json and prints the list
```

and in its `gateway.json`, `"agentModels": "~/.config/herdr-chatgpt/agent-models.json"`. On machines without the repo, copy the script, or copy the file generated on the workstation: a CLI missing on the machine that runs the script keeps the entries another machine wrote. Rerun it when a CLI ships a new model.

**Warning for the human:** the script adds each CLI's full-access options to every model (`FULL_ACCESS` in the script): Claude Code starts with `--dangerously-skip-permissions`, Codex with `--dangerously-bypass-approvals-and-sandbox`, Cursor with `--force --trust` and OpenCode with `--auto`. The agents will commit, push and delete without asking. If you do not want that, edit `FULL_ACCESS` before generating the file. Anything that must stay the owner's decision also needs a protection outside the agent (for example, branch protection on GitHub).

Each CLI needs its session logged in on each machine (`claude`, `codex login`, `cursor-agent login`, `opencode auth login`, pi's OpenRouter key…), **[HUMAN]**. OAuth sessions are not copied between machines: sharing a refresh token can log out the session on one of them.

Verification: `bridge_status` lists the CLIs in `agent_kinds` and each CLI's models under `agents`.

---

## 17. Phase 15 (optional, experimental): native Events and OAuth issuer

With Events, ChatGPT receives `agent.finished` and `agent.asks` through a signed webhook, without an open card. It requires a real OAuth connection. The code is there, but **as of this document's date, no real subscription from ChatGPT has been completed**: in the last recorded test, the OAuth connection was made and ChatGPT listed the events, but it never called `events/subscribe`. Keep the `watch_here` card (`docs/chatgpt-link.md`) as the main path.

The reference is `docs/mcp-events.md` (protocol, grants, network policy, tests) and `issuer/README.md` (issuer). This section covers the order and what the recorded deployment learned.

### 17.1 Decisions up front [HUMAN]

- Expose the issuer and the OAuth listener's `/mcp` route publicly (ports 80 and 443). `/mcp` answers 401 without a valid token, but it is on the Internet.
- A DNS name `<ISSUER_HOST>` pointing at the server.
- The issuer owner's password. Whoever has it can run commands on the machines through ChatGPT: make it long, in a password manager.

### 17.2 OAuth listener in the MCP [AGENT]

Add to `/etc/herdr-mcp/ovh.json` (copy it first), keeping `machines`, `defaultMachine` and `notify`:

```json
"auth": {
  "listenPort": <AUTH_PORT>,
  "resource": "<MCP_RESOURCE>",
  "issuer": "https://<ISSUER_HOST>",
  "jwksPath": "/etc/herdr-mcp/issuer-jwks.json",
  "grantsPath": "/etc/herdr-mcp/principal-grants.json",
  "requiredScopes": ["workdone"],
  "algorithms": ["RS256"]
},
"events": {
  "statePath": "/var/lib/herdr-mcp/events.sqlite",
  "callbackHosts": ["<ISSUER_HOST>"]
}
```

- With `auth.listenPort`, the same process serves 8787 without authentication (the phase 10 app keeps working) and `<AUTH_PORT>` with OAuth. Without `listenPort`, 8787 starts requiring a token and the No Auth app stops working.
- `callbackHosts` starts out with your own name as a placeholder. The real host of ChatGPT's callback is read from the journal (`callback_host`) on the first subscription and swapped in (`docs/mcp-events.md`, "Callback network policy").
- `principal-grants.json`: `{"subjects": {"owner": {"scopes": ["workdone"], "machines": ["<WORKSTATION_MACHINE>"]}}}`, `root:herdr-mcp`, 640. `owner` is the issuer's `OWNER_SUBJECT`.
- `issuer-jwks.json` is copied from the issuer in 17.3.

The MCP does not start with `auth` without the JWKS, so restart after 17.3 for this change.

### 17.3 Issuer [AGENT + HUMAN]

`scripts/deploy-issuer.sh` is made for one specific server (Caddy inside a Docker container, Docker bridge network, fixed default name; see §21). On another server, do it by hand, with Caddy installed on the system:

```bash
# on the workstation: copy the issuer
(cd <REPO_DIR> && tar -cf - --exclude node_modules issuer/src issuer/package.json issuer/bun.lock issuer/tsconfig.json) |
  ssh <SERVER_SSH_ALIAS> 'rm -rf /tmp/wd-issuer && mkdir /tmp/wd-issuer && tar -xf - -C /tmp/wd-issuer'
```

```bash
# on the server
node --version                                   # 24.x
sudo rm -rf /opt/workdone-issuer && sudo mkdir /opt/workdone-issuer
sudo cp -r /tmp/wd-issuer/issuer/. /opt/workdone-issuer/ && sudo chown -R root:root /opt/workdone-issuer
(cd /opt/workdone-issuer && sudo /usr/local/bin/bun install --frozen-lockfile --production)
id workdone-issuer >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/workdone-issuer --shell /usr/sbin/nologin workdone-issuer
sudo install -d -m 700 -o workdone-issuer -g workdone-issuer /var/lib/workdone-issuer
sudo install -d -m 750 -o root -g workdone-issuer /etc/workdone-issuer
printf 'ISSUER_URL=https://%s\nMCP_RESOURCE=%s\nOWNER_SUBJECT=owner\n' '<ISSUER_HOST>' '<MCP_RESOURCE>' |
  sudo tee /etc/workdone-issuer/env >/dev/null
sudo chown root:workdone-issuer /etc/workdone-issuer/env && sudo chmod 640 /etc/workdone-issuer/env
```

Keys and password, **[HUMAN]** on the server (the password goes through stdin and does not end up in the history):

```bash
read -rs PW && printf '%s\n' "$PW" | sudo -u workdone-issuer /usr/local/bin/bun /opt/workdone-issuer/src/setup.ts /var/lib/workdone-issuer; unset PW
```

`setup.ts` writes `signing-key.json`, `cookie-keys.json`, `password-hash` (600) and `jwks.json` (public). It refuses to replace an existing signing key. `--rotate-password` changes only the password.

Unit: the one in the repo requires Docker (`Requires=docker.service`) because the original issuer listened on the Docker bridge network. Without Docker, install it without that dependency and the issuer listens on `127.0.0.1:8790` (the default):

```bash
sed -e '/^Requires=docker.service/d' -e 's/ docker.service//' -e '/^# Listens on the Docker bridge/d' \
  /opt/herdr-chatgpt-bridge/deploy/systemd/workdone-issuer.service |
  sudo tee /etc/systemd/system/workdone-issuer.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now workdone-issuer
curl -fsS http://127.0.0.1:8790/healthz && echo
```

JWKS and grants for the MCP, and restart:

```bash
sudo install -m 640 -o root -g herdr-mcp /var/lib/workdone-issuer/jwks.json /etc/herdr-mcp/issuer-jwks.json
# write /etc/herdr-mcp/principal-grants.json (17.2), root:herdr-mcp 640
sudo systemctl restart herdr-mcp
curl -s 127.0.0.1:<AUTH_PORT>/healthz; echo
```

### 17.4 Public route with Caddy [AGENT, after the 17.1 decision]

The MCP only accepts loopback `Host` headers (protection against DNS rebinding), so Caddy rewrites it. Everything that is not `/mcp` goes to the issuer, which also serves the protected resource metadata at its origin. Block for `/etc/caddy/Caddyfile` (adapted from `deploy/Caddyfile.issuer`, which points at the Docker network):

```caddy
<ISSUER_HOST> {
	encode zstd gzip
	handle /mcp* {
		reverse_proxy 127.0.0.1:<AUTH_PORT> {
			header_up Host 127.0.0.1:<AUTH_PORT>
		}
	}
	handle {
		reverse_proxy 127.0.0.1:8790
	}
}
```

```bash
sudo cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M%S)
# add the block
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

With Caddy on the system itself you do not need `workdone-mcp-bridge.socket` or `.service`: they only exist so that a Caddy in Docker can reach the server's loopback.

Verification:

```bash
curl -s https://<ISSUER_HOST>/.well-known/openid-configuration | jq -c '{code_challenge_methods_supported, client_id_metadata_document_supported}'
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<ISSUER_HOST>/mcp -H 'content-type: application/json' -d '{}'
```

Expected: `{"code_challenge_methods_supported":["S256"],"client_id_metadata_document_supported":true}` and `401`.

### 17.5 Connection in ChatGPT [HUMAN]

- Create a **second** MCP app (do not touch the phase 10 one): **Server URL** connection with `<MCP_RESOURCE>`, **OAuth** authentication. Sign in on the issuer page with the password and approve. The sign-in interaction expires after 10 minutes.
- Optional: package `plugin/workdone-events/` the same way as in 12.2 (its `.app.json` with the ID of this second app) and upload it.
- **Refresh tools** in the app settings and check that `agent.finished` and `agent.asks` appear.
- This app is the same MCP: a chat that uses it has all the WorkDone tools, not just events.

About the second tunnel: `scripts/ovh-setup-events-tunnel.sh <TUNNEL_ID_2>` and `deploy/systemd/openai-herdr-events-tunnel.service` set up a separate tunnel to the OAuth listener. In the recorded deployment, ChatGPT could not discover OAuth through the tunnel ("Couldn't discover OAuth settings", "Couldn't create MCP app") and it switched to the public route from 17.4. If you try it, adapt the port and `MCP_OAUTH_TRUSTED_ORIGINS` (§21).

What remains after that (subscription in a chat, reading `callback_host`, generating the egress policy with `scripts/events-egress-policy.ts`, real delivery, unsubscribe) is in `docs/mcp-events.md`, "Prove it in ChatGPT".

### 17.6 Secret cleanup

- If the password was generated into a file, the human stores it in their password manager and deletes the file.
- Revoke: deleting the subject from `principal-grants.json` cuts access immediately. Deleting `/var/lib/workdone-issuer/oidc.sqlite` forgets all authorizations.

---

## 18. Daily operation and updates

Status and logs (on the server):

```bash
systemctl is-active herdr-mcp openai-herdr-tunnel
curl -s 127.0.0.1:8787/healthz; echo; curl -s 127.0.0.1:8080/readyz; echo
sudo journalctl -u herdr-mcp -n 50 --no-pager
sudo journalctl -u openai-herdr-tunnel -n 50 --no-pager -o cat
```

Tunnel diagnostics (the key comes from the `EnvironmentFile` and is not printed):

```bash
sudo systemd-run --wait --pipe -p User=herdr-mcp -p EnvironmentFile=/etc/herdr-mcp/tunnel.env \
  -E TUNNEL_CLIENT_PROFILE_DIR=/etc/herdr-mcp/tunnel-client -E HOME=/var/lib/herdr-mcp \
  /opt/tunnel-client/tunnel-client doctor --profile herdr-mcp --explain
```

With the service running, everything gives PASS except `health_listener` ("address already in use"), because the service itself holds port 8080. Without OAuth, `oauth_metadata` gives PASS with "all candidates returned HTTP 404".

Audit log on each machine: `tail -f ~/.local/state/herdr-chatgpt/audit.jsonl`.

Updating:

| What | How |
| --- | --- |
| Workstation gateway | `scripts/install-gateway.sh`. It does not touch `gateway.json` |
| Server gateway and MCP | `scripts/deploy-ovh.sh <SERVER_SSH_ALIAS>` (requires §14.1). With no gateway on the server: repeat the copy from §8 into `/opt/herdr-chatgpt-bridge.new`, swap the directories and `sudo systemctl restart herdr-mcp` |
| Extra machines | Run `scripts/add-machine.sh` again with the same arguments (it is idempotent and does not touch their `gateway.json`) |
| Plugin | Edit `plugin/herdr-remote/`, repackage (12.2) and "Upload new version" (12.3) |
| New or changed tools | **[HUMAN]** ChatGPT settings → Plugins → the app → **Manage app** → **Refresh tools**, and open a new chat: open chats keep the old list |
| Repos and roots | Edit `repos` and `allowedRoots` in `gateway.json`; takes effect from the next call |

If a machine sleeps or leaves the tailnet, its calls return `machine_offline` for 60 s and listings do not wait for it.

---

## 19. Rotate the tunnel API key

1. **[HUMAN]** Create a new key with the phase 8 settings (Restricted, only Tunnels Read + Use) and click "Copy" by hand.
2. **[HUMAN]** Run phase 9 with the new key.
3. **[AGENT]** Check `curl -s 127.0.0.1:8080/readyz` → `ready`. If there is an Events tunnel, `sudo systemctl restart openai-herdr-events-tunnel` (it reads the same `tunnel.env`) and check its `/readyz` on 8081.
4. **[HUMAN]** Revoke the old key on the API keys page.

---

## 20. Known failures and fixes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `bun install` on the server: `UnknownLockfileVersion` | Server Bun differs from the workstation's | Install the workstation's version at `/usr/local/bin/bun` (phase 2) |
| The gateway does not start: error reading `agent-models.json` | The example `gateway.json` points at a model file that does not exist | Generate it (§16.2) or remove `agentModels` |
| `allowed root is too broad` or `repo … is outside allowedRoots` | Root `/` or `~`, or repo outside the roots | Specific roots that exist; repos inside them |
| `Host key verification failed` | Server `known_hosts` empty or with a different key | Repeat phase 5 comparing fingerprints. Never `StrictHostKeyChecking=no` |
| `Permission denied (publickey)` from the server | `authorized_keys` line missing, `from=` with a different IP, or Tailscale SSH answering on 22 | Check the line and `RunSSH`. If sshd sees `127.0.0.1` or another IP instead of the tailnet one, Tailscale is running in userspace mode |
| `tunnel-client init` fails right after writing `tunnel.env` | `runuser` keeps the current directory and `herdr-mcp` cannot read it | The script already does `cd /tmp`; if run by hand, do the same |
| The script says "that does not look like an OpenAI API key" | The clipboard did not have the key (an automated "Copy" click that did not land) | The human clicks "Copy" and repeats |
| `control plane API key is malformed`, restart every 5 s | `tunnel.env` with content that is not the key | Repeat phase 9; if the key was exposed, rotate it |
| `OAuth discovery failed … invalid character` warning in the tunnel | A 404 with a text body at `/.well-known/…`; `tunnel-client` parses it as JSON | The current MCP answers 404 with no body. If it shows up, the deployed code is old |
| ChatGPT: "No tunnels yet" | Tunnel associated with another ChatGPT workspace | Edit the tunnel in Platform, tick the right workspace, wait about 30 s |
| Plugin upload rejected: `apps.herdr-remote.id must begin with asdk_app_…` | `plugin_asdk_app_…` was copied from the URL | Remove `plugin_`, repackage |
| "Couldn't add plugin" when uploading a version | "Add → Upload plugin archive" was used, which creates another plugin | Plugin page → "…" → "Upload new version" |
| ChatGPT: "No tool was defined"; the plugin says "No app tools available yet" | The app was deleted on the assumption that it was a duplicate | Recreate the app (§12.1), put the new ID in `.app.json`, "Upload new version" |
| New tools do not show up | ChatGPT caches the tool list | **Refresh tools** and a new chat. If done with browser automation, the button has to be in view before the click |
| After restarting `herdr-mcp`, ChatGPT loses WorkDone for several minutes | `tunnel-client` probes the MCP only once at startup and leaves the channel disabled (`/api/status`: `"enabled": false`, `initial mcp probe failed`) | The current unit waits for `/healthz` in `ExecStartPre`. Reinstall the unit from the repo if it is old |
| First prompt to a freshly started agent: `agent_not_ready` | The agent is not `idle` yet | Wait for `idle` (`wait_agent`); `spawn_agent` already does |
| `list_dir ~/Downloads` on macOS: `permission_denied` | Folders protected by privacy settings | "Full disk access for remote users" (§2), or do not use them |
| `exec` of `gh` or another CLI gives 401, but works in a pane | The gateway's SSH login has no keychain, ssh-agent or `.zshrc` | `"execInPane": true` on that machine |
| A machine's panes do not find `claude`/`codex` | Herdr server started with a minimal `PATH` | `default_shell` and `shell_mode = "login"` in the Herdr config and `herdr server reload-config` (§15) |
| The first character of a command typed into a new pane is lost | An interactive shell prompt (for example the oh-my-zsh update) eats the keystroke | Remove the prompt, for example `zstyle ':omz:update' mode reminder` |
| An agent shows as `agent: null` or "gone" even though it is still alive | Something stopped it with SIGSTOP and, after SIGCONT, it was left in the background | `fg` in the pane's shell and `watch_agent` again. Do not stop agent processes from outside |
| Codex fails to save folder trust or in `account/read` | The CLI was updated mid-session and got out of sync with its app-server | Close and reopen the agent; same Codex version on all machines |
| `scp` fails against a machine | Some NAS devices do not accept it | `ssh ALIAS 'cat > path' < file` |
| Port taken (8787, 8080, 8081, `<AUTH_PORT>`, 8790) | Another service on the server | Pick another one and change it everywhere (§21) |
| ChatGPT: "Couldn't discover OAuth settings" with a Tunnel + OAuth connection | OAuth discovery through the tunnel did not work in the recorded test | Public route with Caddy and a Server URL connection (§17.4) |
| The OAuth token exchange fails because of the client authentication method | ChatGPT's client document declares `private_key_jwt` and its token request arrived as a public client | The issuer already accepts `none` and `private_key_jwt`. If the issuer journal still shows `grant.error`, add to `/var/lib/workdone-issuer/clients.json` a static public client with `client_id` `https://chatgpt.com/oauth/client.json` and the `redirect_uris` from the error. Not verified outside the original deployment |
| `invalid_token` on every OAuth call | `ISSUER_URL` ≠ `auth.issuer` or `MCP_RESOURCE` ≠ `auth.resource` | Make them equal and reconnect in ChatGPT |
| The agent's permission classifier blocks a step | Automatic agent policy (remote writes, deploys, credentials) | Do not work around it: the human runs the command |

---

## 21. Hardcoded values in the scripts and how to adapt them

The scripts were written for one specific deployment. What they hardcode:

| File | Hardcoded value | How to adapt it |
| --- | --- | --- |
| `scripts/deploy-ovh.sh` | Default SSH alias `ovh` | Pass `<SERVER_SSH_ALIAS>` as the first argument, or create `Host ovh` in `~/.ssh/config` |
| `scripts/deploy-ovh.sh` | Machine name `ovh` in `machines.ovh`, `notify.machine` and the `id_ed25519_ovh` key | Accept it, or edit the script. ChatGPT sees that name |
| `scripts/deploy-ovh.sh` | Server gateway required (fails if local `bridge_status` does not respond) | With no Herdr on the server, update by hand (§18) |
| `scripts/deploy-ovh.sh` | `notifyCommand` only if a notification script exists at one of the author's paths | Set `notifyCommand` by hand (§14.2) |
| `scripts/deploy-ovh.sh`, `scripts/add-machine.sh` | Passwordless `sudo`, `/usr/local/bin/bun` on the server, `~/.bun/bin/bun` on extra machines | Meet those requirements |
| `scripts/add-machine.sh`, `scripts/deploy-issuer.sh` | Default server `ovh` | `OVH_HOST=<SERVER_SSH_ALIAS>` |
| `scripts/add-machine.sh` | `agentKinds: ["claude","codex"]` and `extraPath` with `~/.npm-global/bin` in the new config | Edit the machine's `gateway.json` afterwards |
| `scripts/install-gateway.sh` | Creates `gateway.json` from `config/mac-gateway.example.json` on Linux too (`shell` `/bin/zsh`, `/opt/homebrew/bin`, aliases that may not exist) | Edit it (phase 1) |
| `scripts/install-watcher.sh` and `deploy/launchd/*.plist` | launchd label with the author's prefix | Cosmetic only; usually not installed (§14.2) |
| `scripts/ovh-setup-tunnel.sh` | Ports 8787 (MCP) and 8080 (tunnel health) | If they change, edit the script, `ovh.json` and the `ExecStartPre` of `openai-herdr-tunnel.service` |
| `scripts/ovh-setup-events-tunnel.sh` | OAuth port `8789`, admin `8081`, sample `sample_mcp_with_dcr` | Edit if `<AUTH_PORT>` is different. The sample has not been seen working with ChatGPT (§17.5) |
| `deploy/systemd/openai-herdr-events-tunnel.service` | `MCP_OAUTH_TRUSTED_ORIGINS` with the original issuer's name and `ExecStartPre` against `8789` | Set `https://<ISSUER_HOST>` and `<AUTH_PORT>` |
| `scripts/deploy-issuer.sh` | Default name tied to the original server's IP, Caddy inside a specific Docker container (fixed container name and Caddyfile path), issuer on `172.24.0.1:8790` | Do not use it as is: manual procedure from §17.3 and §17.4 |
| `deploy/Caddyfile.issuer` | Original issuer's name and Docker network addresses (`172.24.0.1:8790`, `:8792`) | Block from §17.4 |
| `deploy/systemd/workdone-issuer.service` | `Requires=docker.service` | Remove it if there is no Docker (§17.3) |
| `deploy/systemd/workdone-mcp-bridge.{socket,service}` | `172.24.0.1:8792` → `127.0.0.1:8789` | Only needed with Caddy in Docker |
| `plugin/herdr-remote/` | Machine names, repos, browser section and author | Review before packaging (§12.2) |
| `plugin/workdone-events/.codex-plugin/plugin.json` | Mentions the author's machines | Adjust the text |
| `config/ovh-gateway.example.json` | `browser` section with paths of one of the author's tools | Remove it unless that tool exists |

---

## 22. Uninstall

**[HUMAN]** In ChatGPT: uninstall and delete the plugin, then delete the app (and the Events one if it exists).

**[HUMAN]** In OpenAI Platform: delete the tunnel or tunnels and revoke the API key.

**[AGENT]** On the server:

```bash
sudo systemctl disable --now openai-herdr-events-tunnel workdone-issuer 2>/dev/null || true
sudo systemctl disable --now openai-herdr-tunnel herdr-mcp
sudo rm -f /etc/systemd/system/openai-herdr-tunnel.service /etc/systemd/system/openai-herdr-events-tunnel.service \
  /etc/systemd/system/herdr-mcp.service /etc/systemd/system/workdone-issuer.service
sudo rm -rf /etc/systemd/system/herdr-mcp.service.d
sudo systemctl daemon-reload
sudo rm -rf /etc/herdr-mcp /opt/herdr-chatgpt-bridge /opt/herdr-chatgpt-bridge.old-* /opt/tunnel-client /var/lib/herdr-mcp
sudo rm -rf /etc/workdone-issuer /opt/workdone-issuer /var/lib/workdone-issuer
sudo userdel herdr-mcp; sudo userdel workdone-issuer 2>/dev/null || true
sudo rm /usr/local/bin/bun            # only if nothing else uses it
```

Also remove the Caddy block if you added it, and on the server the `herdr-chatgpt-ovh-local` line from `~/.ssh/authorized_keys` plus `~/.local/libexec/herdr-chatgpt`, `~/.config/herdr-chatgpt`, `~/.local/state/herdr-chatgpt` if its gateway was installed.

**[AGENT]** On the workstation and on each extra machine:

```bash
cp -p ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-uninstall
grep -v 'herdr-chatgpt' ~/.ssh/authorized_keys.bak-uninstall > ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys
rm -rf ~/.local/libexec/herdr-chatgpt ~/.config/herdr-chatgpt ~/.local/state/herdr-chatgpt ~/.local/bin/workdone-tell
```

The `grep -v` removes every line that mentions `herdr-chatgpt` (the bridge keys' comments and the launcher path). Check the result with `diff` before closing the SSH session.
