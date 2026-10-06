---
name: workdone-release
description: Cut and ship a full WorkDone release, end to end - bump versions, run the checks, commit, deploy the gateway and MCP, build the two plugin zips, upload them to the existing private ChatGPT plugins through the browser, press Refresh tools on both apps and verify on the OVH journal. Use whenever the user says release, ship, deploy, bump, "upload the plugin", "new version", "refresh tools" or "full release" for WorkDone, Herdr remote, the WorkDone Events plugin, the gateway or the MCP server, even if they only name one step, because the steps depend on each other and half a release leaves ChatGPT on stale tools.
---

# WorkDone full release

A release has four parts that have to land together: the code (gateway on each machine, MCP on OVH), two plugin zips, the ChatGPT-side upload of those zips, and a tools refresh so ChatGPT re-reads the tool and event lists. Skipping the last two is the usual failure: the server is new and ChatGPT keeps calling the old schema.

Real hostnames and ids are not in this repo (it is public). Read `.context/release-ids.md` for plugin page URLs and app ids, and `docs/DEPLOYMENT.md` sections 12.2, 12.3 and 18 for the background. Read `docs/loop-risks.md` first if the change touches watches, events, spawns or nudges.

## 1. Bump and check

Versions live in four places. Bump only what changed, but a gateway or MCP change that alters tools normally bumps the plugin too.

| Version | File |
| --- | --- |
| Gateway | `GATEWAY_VERSION` in `gateway/config.ts` |
| MCP | `version` in `buildServer` (`mcp/src/tools.ts`, the `herdr-remote` server) |
| WorkDone plugin | `plugin/herdr-remote/.codex-plugin/plugin.json` |
| Events plugin | `plugin/workdone-events/.codex-plugin/plugin.json` |

Run `bun run check` (typecheck and every test; the pre-commit hook runs it too). Commit with a message like `Release gateway X, MCP Y, WorkDone Z, Events W`, using `git commit -F - <<'EOF'`. Push only if the user asked.

## 2. Deploy the code

- Mac gateway: `scripts/install-gateway.sh` (does not touch `gateway.json`).
- OVH gateway and MCP: `scripts/deploy-ovh.sh ovh`. Take the backups the script does not (the previous `/opt/herdr-chatgpt-bridge` dir) if the change is risky.
- Other machines (syno): `scripts/add-machine.sh` with the same arguments as before, only when the user wants them on the new gateway.
- After `herdr-mcp` restarts, check `systemctl is-active herdr-mcp openai-herdr-tunnel workdone-mcp-bridge.service`. `herdr-mcp` has `Requires=` dependents: a stop takes them down and a later start does not bring them back, so start them explicitly.
- If the permission classifier blocks a deploy command, do not route around it. Give the user the exact command.

Confirm the new versions answer: gateway version from the audit log or the machine listing, MCP from `curl -s 127.0.0.1:8787/healthz` on OVH.

## 3. Build the zips

Both zips are named by version so old ones stay for rollback. The `.app.json` files are gitignored and must be present (they hold the app ids); a zip without them is rejected.

```bash
v=$(jq -r .version plugin/herdr-remote/.codex-plugin/plugin.json)
e=$(jq -r .version plugin/workdone-events/.codex-plugin/plugin.json)
(cd plugin && zip -qr -X ../dist/herdr-remote-plugin-$v.zip herdr-remote \
  -x '*.DS_Store' -x 'herdr-remote/.gitignore' -x 'herdr-remote/.app.json.example')
(cd plugin && zip -qr -X ../dist/workdone-events-plugin-$e.zip workdone-events \
  -x '*.DS_Store' -x 'workdone-events/.app.json.example')
unzip -l dist/herdr-remote-plugin-$v.zip dist/workdone-events-plugin-$e.zip
```

Each listing must show `.app.json`, `.codex-plugin/plugin.json` and the skill's `SKILL.md`.

## 4. Upload through the browser

Use the browser tool you actually have. In Claude Code that is Claude in Chrome (`mcp__claude-in-chrome__*`, load it with the `claude-in-chrome` skill and one ToolSearch call). In Codex it is the `cua_repl` browser tool, or `chrome-canary-cdp` when a signed-in CDP browser is needed (read its skill first and run `chrome-canary-cdp remove` afterwards). If neither is available, hand the user the zip paths and the steps below.

The user's request to release is the authorization to touch exactly two things: the two existing private plugins, and Refresh tools on their two apps. Never create a plugin, never use "Add > Upload plugin archive" (it makes a duplicate), never change visibility, never open other apps.

For each plugin page (WorkDone first, then Events):

1. Open the page URL from `.context/release-ids.md` in a tab you create. Read the current version from Information (scroll down, or `get_page_text`). Note it for the report.
2. Click the "..." menu right of the title, then "Upload new version". The menu sits at about (968, 104) at a 1456x820 viewport.
3. Do not click Choose file, it opens a native picker you cannot see. Find the dialog's file input (`find` "file input") and attach the zip with `file_upload`. In Codex, set the input through the browser API instead.
4. Wait for "New version uploaded" (up to ~15 s; the dialog shows "Uploading ..." first). Reload the page and confirm Information > Version equals the new version.

## 5. Refresh tools on both apps

Refresh tools lives on the app's settings page, not on the plugin page. Typing `/settings/plugins-settings/<asdk id>` directly fails with "Couldn't load plugin settings". Instead:

1. Go to `https://chatgpt.com/settings/plugins-settings`, click the search box, type `WorkDone`. If the typing is lost (the first click after a page load often loses focus), click the box again and retype.
2. Open the row for the app: "WorkDone Tunnel" for the tunnel, and the "WorkDone Events" row whose description says "OAuth connection to the Herdr MCP" (the other Events row is the plugin, not the app). The URL becomes `plugin_asdk_app_<id>`.
3. Wait for the page to finish loading before clicking. The layout shifts a few seconds after load (the Tunnel page moved the button about 22 px), so take a fresh screenshot, then click "Refresh tools" with a coordinate click, scrolled into view. It sits right above the red "Delete app" row, so zoom on the region first and click the left row, never the red one. Ref clicks do not register on these buttons.
4. After the click, the button greys out for a few seconds and no success toast appears. The OVH journal is the evidence, so check it after each app instead of trusting the UI. If the journal shows no new lines, re-click once.

## 6. Verify on OVH

```bash
ssh ovh 'sudo journalctl -u herdr-mcp --since "-10min" --no-pager -o cat | grep -E "server/discover|tools/list|events/list" | cut -c1-120'
```

Expect `server/discover` plus `tools/list` for the Tunnel refresh and `server/discover`, `tools/list` and `events/list` for the Events refresh (the authenticated 8789 listener). The log lines do not say which port they hit, so do not claim a port; say what appeared and in what order. If the release adds an event type (for example `coord.changed`), check it is in the deployed event list rather than assuming.

## 7. Clean up and report

Close every tab you opened. Report: saved version of each plugin (before and after), the Refresh tools outcome per app, and the journal lines. Do not claim a chat wake or that open chats have the new tools: open chats keep the old tool list, so the user needs a new chat to see changes. Update the deploy-state memory with the versions, commit hash and anything still pending.
