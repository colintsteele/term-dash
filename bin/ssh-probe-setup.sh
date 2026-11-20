#!/bin/bash
#
# The key the strip's SSH cell logs in with to prove :2223 works end to end.
#
# A listening port isn't enough: sshd can be up, accept the laptop's key, and
# still refuse the login at PAM's account step ("Access denied ... by PAM account
# configuration"), which is what happened when Kandji's "Disable Remote Login"
# ran. So the cell logs in for real, as the laptop would, with this key.
#
# The key can do nothing but that: `restrict` (no shell, no forwarding, no pty),
# `command="true"`, and only from this machine. Idempotent; no root needed.
set -euo pipefail

KEY="$HOME/.ssh/term-dash-probe"
AUTH="$HOME/.ssh/authorized_keys"

[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C "term-dash-probe" -f "$KEY"
pub=$(cut -d' ' -f1,2 "$KEY.pub")
touch "$AUTH" && chmod 600 "$AUTH"
if grep -qF "$pub" "$AUTH"; then
  echo "probe key already authorized"
else
  echo "restrict,command=\"true\",from=\"127.0.0.1,::1\" $pub term-dash-probe" >> "$AUTH"
  echo "authorized $KEY.pub for localhost only"
fi
