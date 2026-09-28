#!/bin/sh
# Print the authorized_keys line for the bridge key.
# usage: render-authorized-key.sh <ovh-tailscale-ip> <launcher-absolute-path> <public-key-file>
set -eu
[ $# -eq 3 ] || { echo "usage: $0 <ovh-tailscale-ip> <launcher-absolute-path> <public-key-file>" >&2; exit 2; }
ip=$1 launcher=$2 pub=$3
case $ip in *[!0-9.:a-f]*|'') echo "not an IP address: $ip" >&2; exit 2 ;; esac
case $launcher in /*) ;; *) echo "launcher path must be absolute" >&2; exit 2 ;; esac
case $launcher in *'"'*|*' '*) echo "launcher path must not contain quotes or spaces" >&2; exit 2 ;; esac
set -- $(cat "$pub")
[ "$1" = ssh-ed25519 ] || { echo "expected an ssh-ed25519 public key" >&2; exit 2; }
printf 'from="%s",restrict,command="%s" %s %s %s\n' "$ip" "$launcher" "$1" "$2" "${3:-herdr-chatgpt-ovh}"
