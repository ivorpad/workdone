#!/bin/sh
# Port 22 answers only on loopback and the tailnet; everything else is dropped.
# A public sshd draws scanners that fill MaxStartups, and sshd then drops new
# connections at random, the MCP server's own to 127.0.0.1 included.
# Run by deploy/systemd/ssh-tailnet-only.service.
#
# usage: ssh-tailnet-only.sh start|stop
set -eu
for ipt in iptables ip6tables; do
  case ${1:-} in
    start)
      $ipt -N workdone-ssh 2>/dev/null || $ipt -F workdone-ssh
      $ipt -A workdone-ssh -i lo -j ACCEPT
      $ipt -A workdone-ssh -i tailscale0 -j ACCEPT
      $ipt -A workdone-ssh -j DROP
      $ipt -C INPUT -p tcp --dport 22 -j workdone-ssh 2>/dev/null || $ipt -I INPUT 1 -p tcp --dport 22 -j workdone-ssh
      ;;
    stop)
      while $ipt -D INPUT -p tcp --dport 22 -j workdone-ssh 2>/dev/null; do :; done
      $ipt -F workdone-ssh 2>/dev/null || true
      $ipt -X workdone-ssh 2>/dev/null || true
      ;;
    *) echo "usage: $0 start|stop" >&2; exit 2 ;;
  esac
done
