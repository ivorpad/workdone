#!/bin/sh
# Install or update the gateway on this machine (macOS or Linux). Never overwrites an
# existing gateway.json. BUN=/path/to/bun picks the runtime; default ~/.bun/bin/bun.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
dest="$HOME/.local/libexec/herdr-chatgpt"
conf="$HOME/.config/herdr-chatgpt/gateway.json"
bun=${BUN:-$HOME/.bun/bin/bun}
[ -x "$bun" ] || { echo "no bun at $bun; set BUN=/path/to/bun" >&2; exit 1; }

install -d -m 700 "$dest" "$(dirname "$conf")"
# Replace the whole module set so a file removed from the repo does not linger.
rm -f "$dest"/*.ts
for f in "$repo"/gateway/*.ts; do
  install -m 600 "$f" "$dest/$(basename "$f")"
done
install -m 700 "$repo/gateway/herdr-gateway-launcher.sh" "$dest/herdr-gateway-launcher.sh"
printf '%s\n' "$bun" > "$dest/bun-path"
chmod 600 "$dest/bun-path"

if [ ! -e "$conf" ]; then
  install -m 600 "$repo/config/mac-gateway.example.json" "$conf"
  echo "wrote $conf from the example; edit allowedRoots and repos"
fi
chmod 600 "$conf"
# Agents in any repo message their linked ChatGPT chat with: workdone-tell "message"
install -d -m 755 "$HOME/.local/bin"
install -m 755 "$repo/scripts/tell.sh" "$HOME/.local/bin/workdone-tell"
# and report their coordination task with: workdone-task '{"status":"executing"}'
install -m 755 "$repo/scripts/task.sh" "$HOME/.local/bin/workdone-task"
# Claude Code hooks: an agent learns who sent what WorkDone typed into its pane, without a
# footer in the text, and hands over its exact answer (gateway/hooks.ts).
install -m 755 "$repo/scripts/hook.sh" "$HOME/.local/bin/workdone-hook"
# The hook checks a flag file here before it starts anything.
"$bun" -e 'const { loadConfig } = await import(process.argv[1]); const fs = await import("node:fs"); process.stdout.write(loadConfig(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))).stateDir)' "$dest/config.ts" "$conf" > "$dest/state-dir.tmp" &&
  mv "$dest/state-dir.tmp" "$dest/state-dir" && chmod 600 "$dest/state-dir" || { rm -f "$dest/state-dir.tmp"; echo "could not read stateDir from $conf: workdone-hook stays idle" >&2; }
echo "installed gateway to $dest (bun: $bun), and workdone-tell, workdone-task and workdone-hook to ~/.local/bin"

# Add the hooks to Claude Code's user settings, once, when Claude Code is set up here.
# WORKDONE_NO_CLAUDE_HOOKS=1 leaves the settings alone (the footer then stays on every message).
settings="$HOME/.claude/settings.json"
hook="$HOME/.local/bin/workdone-hook"
if [ -n "${WORKDONE_NO_CLAUDE_HOOKS:-}" ] || [ ! -d "$HOME/.claude" ]; then
  :
elif ! command -v jq >/dev/null 2>&1; then
  echo "no jq here: add workdone-hook to $settings by hand (SessionStart, UserPromptSubmit, Stop)" >&2
else
  [ -e "$settings" ] || printf '{}\n' > "$settings"
  # Drop any earlier workdone-hook entries, then add one per event.
  next=$(jq --arg hook "$hook" '
    def mine: (.hooks // []) | any(.command? // "" | contains("workdone-hook"));
    def entry($event; $timeout): { hooks: [{ type: "command", command: "\($hook) \($event)", timeout: $timeout }] };
    .hooks //= {}
    | reduce (["SessionStart", 10], ["UserPromptSubmit", 10], ["Stop", 10]) as [$e, $t] (.;
        .hooks[$e] = ([(.hooks[$e] // [])[] | select(mine | not)] + [entry($e; $t)]))
  ' "$settings") || { echo "could not read $settings as JSON: hooks not added" >&2; next=""; }
  if [ -n "$next" ] && [ "$next" != "$(jq . "$settings")" ]; then
    cp -p "$settings" "$settings.bak-workdone-$(date +%Y%m%d%H%M%S)"
    printf '%s\n' "$next" > "$settings.tmp" && mv "$settings.tmp" "$settings"
    echo "added workdone-hook to $settings (SessionStart, UserPromptSubmit, Stop)"
  fi
fi
