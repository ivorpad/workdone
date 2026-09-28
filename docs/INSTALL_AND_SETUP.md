# Installation agent runbook — Herdr ChatGPT Bridge

You are installing a security-sensitive remote control bridge. Work autonomously, but do not weaken a security boundary to make setup easier.

## Goal

Deploy:

```text
ChatGPT → OpenAI Secure MCP Tunnel → private MCP on OVH
       → ordinary OpenSSH over Tailscale → forced Mac gateway → Herdr
```

The Mac already has Herdr installed. Verify the installed version and syntax before making assumptions. The reference implementation was validated against Herdr 0.9.1.

## Non-negotiable constraints

- Do not expose OVH MCP port 8787 publicly.
- MCP must bind to 127.0.0.1.
- Do not use Tailscale SSH for the bridge key. Use ordinary OpenSSH transported over the Tailscale network so `authorized_keys` forced-command restrictions are enforced.
- Do not disable `StrictHostKeyChecking`.
- Do not use the user's general-purpose SSH key. Generate a dedicated bridge key.
- Do not add `sudo` to the Mac gateway.
- Do not replace the user's existing Tailscale policy; merge only the minimum grant needed.
- Keep `allowRawPaneRun=false` initially.
- Keep worktree removal disabled initially.
- Never commit or print the OpenAI tunnel runtime API key.
- Back up any file before editing it.

## Phase 0 — inspect and record facts

On OVH, determine:

```bash
uname -a
cat /etc/os-release
node --version || true
npm --version || true
ssh -V
 tailscale status
```

On the Mac, determine:

```bash
whoami
command -v herdr
herdr --version
herdr agent
herdr pane
herdr worktree
command -v node
node --version
 tailscale status
```

Record:

- OVH Tailscale IP and node name.
- Mac Tailscale IP and MagicDNS name.
- Mac username.
- Mac absolute `herdr` path.
- Mac absolute `node` path.
- existing SSH/Remote Login state.

Do not continue until OVH can reach the Mac Tailscale address.

Determine whether port 22 on the Mac Tailscale IP is **Tailscale SSH** or ordinary
OpenSSH. If Tailscale SSH is enabled, its server intercepts tailnet TCP/22 and the
Mac `authorized_keys` forced-command rule will not govern that connection. Do not
disable an existing Tailscale SSH setup without explicit user approval. Either use
an already-available ordinary OpenSSH path over Tailscale, or provision a separate
ordinary-OpenSSH listener/port restricted to the tailnet and update the grant/config
accordingly. Re-run all forced-command negative tests on the actual port chosen.

## Phase 1 — install the Mac gateway

Copy this repository's `gateway/` files to:

```text
~/.local/libexec/herdr-chatgpt/
```

Make the launcher executable:

```bash
chmod 700 ~/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh
chmod 700 ~/.local/libexec/herdr-chatgpt/herdr-gateway.mjs
```

Copy `config/mac-gateway.example.json` to:

```text
~/.config/herdr-chatgpt/gateway.json
```

Set mode 600. Edit it with the observed paths and explicit allowed roots. Prefer concrete repository roots or a narrow development parent directory. Add repo keys and safe tasks the user actually uses.

If Node is not `/opt/homebrew/bin/node`, edit the launcher. If Herdr is not `/opt/homebrew/bin/herdr`, edit gateway JSON.

Verify locally on the Mac without SSH:

```bash
printf '%s\n' '{"id":"local","op":"bridge_status","params":{}}' | \
  HERDR_GATEWAY_CONFIG="$HOME/.config/herdr-chatgpt/gateway.json" \
  "$HOME/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh"
```

Then test `list_agents` and confirm agents outside allowed roots are absent.

## Phase 2 — dedicated ordinary-OpenSSH key from OVH

Create a dedicated directory and key on OVH as root during provisioning:

```bash
install -d -m 700 /etc/herdr-mcp/ssh
ssh-keygen -t ed25519 -a 100 -N '' -C 'herdr-chatgpt-ovh' -f /etc/herdr-mcp/ssh/id_ed25519
chmod 600 /etc/herdr-mcp/ssh/id_ed25519
```

The final service user will own/read this directory.

On the Mac, append exactly one forced-command key entry to `~/.ssh/authorized_keys`. Use the actual OVH Tailscale IP and launcher absolute path:

```text
from="<OVH_TAILSCALE_IP>",restrict,command="/Users/<user>/.local/libexec/herdr-chatgpt/herdr-gateway-launcher.sh" ssh-ed25519 AAAA... herdr-chatgpt-ovh
```

Use `scripts/render-authorized-key.sh` to generate the line. Preserve all existing authorized keys. Ensure `~/.ssh` is 700 and `authorized_keys` is 600.

Important: confirm this connection is ordinary OpenSSH over Tailscale, not Tailscale SSH. Tailscale provides the network path; sshd and authorized_keys provide command-level authorization.

## Phase 3 — Tailscale least privilege

Inspect the current tailnet policy first. Do not replace it.

Prefer tagging OVH as `tag:herdr-mcp` and the Mac as `tag:ivor-mac` only if those tag semantics fit the existing policy. Merge a grant equivalent to:

```json
{
  "src": ["tag:herdr-mcp"],
  "dst": ["tag:ivor-mac"],
  "ip": ["tcp:22"]
}
```

If tags would unintentionally broaden existing access, use exact existing selectors instead. Validate policy/tests before saving. Verify OVH can access Mac TCP/22 and cannot reach unrelated newly-granted Mac ports because of this change.

## Phase 4 — pin the Mac SSH host key

Do not set `StrictHostKeyChecking=no`.

Obtain the Mac's Ed25519 SSH host public key through a trusted local path (for example while operating directly on the Mac), derive/record its fingerprint, and compare it with the key observed from OVH. Only after they match, create:

```text
/etc/herdr-mcp/ssh/known_hosts
```

containing the Mac MagicDNS name/Tailscale IP host key.

Test the forced gateway from OVH:

```bash
printf '%s\n' '{"id":"smoke","op":"bridge_status","params":{}}' | \
  ssh -T -i /etc/herdr-mcp/ssh/id_ed25519 \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/etc/herdr-mcp/ssh/known_hosts \
  -o ForwardAgent=no -o ClearAllForwardings=yes -o RequestTTY=no \
  <mac-user>@<mac-magicdns>
```

Negative tests are required:

- Attempt to request an ordinary shell with this key; it must still run only the JSON gateway and reject empty/invalid input.
- Attempt a non-Herdr request; gateway must return `unknown_operation`.
- `run_command_in_pane` must return `capability_disabled` while raw execution is off.

## Phase 5 — install OVH MCP service

Install Node >=20 if missing, using the OS-supported method. Do not curl-pipe an unreviewed installer into a root shell.

Create service account:

```bash
useradd --system --home /var/lib/herdr-mcp --create-home --shell /usr/sbin/nologin herdr-mcp
```

Copy repository to:

```text
/opt/herdr-chatgpt-bridge
```

Then:

```bash
cd /opt/herdr-chatgpt-bridge/mcp
npm install --omit=dev
npm run check
```

Copy `config/ovh.example.json` to `/etc/herdr-mcp/ovh.json` and fill actual SSH values. Set ownership/permissions so only root and `herdr-mcp` can read needed files. Make the SSH key and known_hosts owned by `herdr-mcp` and mode 600/644 respectively.

Install `deploy/systemd/herdr-mcp.service`, `systemctl daemon-reload`, enable and start it.

Verify:

```bash
curl --fail http://127.0.0.1:8787/healthz
ss -ltnp | grep 8787
```

The listener MUST be `127.0.0.1:8787`, not `0.0.0.0:8787` and not `[::]:8787`.

Run MCP Inspector from a trusted local/SSH context if available and verify tool discovery plus representative calls.

## Phase 6 — OpenAI Secure MCP Tunnel

This step requires the user's OpenAI Platform organization/account and therefore may require an authenticated browser action.

1. In OpenAI Platform tunnel settings, create a tunnel and associate it with the intended ChatGPT workspace/account.
2. Obtain its `tunnel_id` and a runtime API key permitted to use the tunnel.
3. Install the latest official `openai/tunnel-client` release from the OpenAI Platform download link or the official GitHub release. Verify source/release integrity; do not use a third-party binary.
4. As `herdr-mcp`, initialize:

```bash
export CONTROL_PLANE_API_KEY='<runtime key>'
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile herdr-mcp \
  --tunnel-id '<tunnel_id>' \
  --mcp-server-url 'http://127.0.0.1:8787/mcp'

tunnel-client doctor --profile herdr-mcp --explain
```

If this release's quickstart requires a different sample for HTTP, follow `tunnel-client help quickstart`; the invariant is profile `herdr-mcp` targeting `http://127.0.0.1:8787/mcp`.

Store only the runtime key in `/etc/herdr-mcp/tunnel.env`:

```text
CONTROL_PLANE_API_KEY=...
```

mode 600, owned by `herdr-mcp`.

Install and enable `deploy/systemd/openai-herdr-tunnel.service`. Check logs and `tunnel-client doctor` until healthy.

## Phase 7 — register ChatGPT app and plugin

In ChatGPT developer mode:

1. Go to Plugins → plus → create developer-mode app.
2. Choose **Tunnel** as connection type.
3. Select the created tunnel or paste its `tunnel_id`.
4. Scan/discover tools and verify Herdr tools appear.
5. Save it and copy the technical ID from the browser URL; it begins `plugin_asdk_app`.

Now create the private plugin using the bundled source in `plugin/herdr-remote/` and Plugin Creator. Preserve `skills/herdr-remote/SKILL.md`, the plugin identity/metadata, and wire the registered app ID.

Use this prompt in ChatGPT Work:

```text
@plugin-creator Create my private plugin from the attached/provided herdr-remote plugin source. Preserve its plugin.json metadata and skills/herdr-remote/SKILL.md exactly unless required for schema validity. Wire the existing registered MCP app with technical ID <plugin_asdk_app...> via .app.json, and make the plugin installable in ChatGPT and Codex. Do not add a public MCP URL and do not broaden tool permissions.
```

The technical ID is account-specific; do not fabricate it and do not store it in the infrastructure repository unless the user explicitly wants that local mapping version-controlled.

## Phase 8 — acceptance tests

From a new ChatGPT Work chat with `@Herdr Remote`:

1. `bridge_status` succeeds.
2. list agents returns only allowed roots.
3. read an agent.
4. prompt an idle test agent with a harmless request and read the response.
5. split a disposable pane and start an allowed agent if appropriate.
6. run a configured repo task.
7. confirm raw command execution is rejected.
8. confirm worktree removal is rejected while disabled.
9. stop the OpenAI tunnel service and confirm ChatGPT loses the path without opening any inbound OVH port.
10. restart it and confirm recovery.

## Phase 9 — optional raw terminal capability

Do not enable this during initial installation.

If the user explicitly decides they want Commander-like arbitrary shell control, change only:

```json
"allowRawPaneRun": true
```

in the Mac gateway config, then test `run_command_in_pane` with a harmless command. Explain that this materially increases blast radius: a shell command can reference secrets outside the pane cwd even though the pane itself belongs to an allowed repo.

## Deliverable

When finished, report only:

- files/configs installed and their locations;
- Mac/OVH connectivity result;
- MCP health result;
- tunnel health result;
- ChatGPT app/plugin result;
- exact capabilities enabled/disabled;
- any remaining manual action that could not be performed because it requires the user's authenticated UI/account action.

Never print private keys or the tunnel runtime API key.
