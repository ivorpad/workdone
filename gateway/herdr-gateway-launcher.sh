#!/bin/sh
# Forced command for the herdr-chatgpt bridge key (see authorized_keys).
# Any command the SSH client asks for arrives in SSH_ORIGINAL_COMMAND and is
# ignored: this key can only ever speak the JSON gateway protocol on stdin.
set -eu
umask 077

DIR=$(cd "$(dirname "$0")" && pwd)
# The installer writes bun-path when this machine should use a bun other than the user's own.
BUN="$HOME/.bun/bin/bun"
[ -r "$DIR/bun-path" ] && BUN=$(cat "$DIR/bun-path")

export PATH=/usr/bin:/bin
export HERDR_GATEWAY_CONFIG="${HERDR_GATEWAY_CONFIG:-$HOME/.config/herdr-chatgpt/gateway.json}"

# Run from the install dir so Bun only sees our bunfig/tsconfig (none), never $HOME's.
cd "$DIR"
exec "$BUN" --no-env-file --no-install ./herdr-gateway.ts
