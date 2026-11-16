#!/bin/bash
#
# Bring sshd up on 2223 and make it stay up across reboots.
#
# This replaces the hand-run `sudo /usr/sbin/sshd -p 2223`, which works fine
# until the next reboot and then silently isn't there — you find out when you're
# away from the machine and can no longer fix it. The strip's SSH readout is the
# warning; this script is the fix, and it's what the readout command-clicks to.
#
# Runs as root (the .app wrapper gets there via the macOS admin prompt).
#
set -euo pipefail

LABEL="com.colinsteele.sshd-2223"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"
PORT=2223

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (try: sudo $0)" >&2
  exit 1
fi

# A plain `Port 2223` in sshd_config would be ignored: macOS starts sshd through
# launchd socket activation, so launchd owns the port and Apple's plist hardcodes
# it to 22. That plist lives under SIP and can't be edited — hence a daemon of
# our own rather than a config tweak.
#
# This one runs sshd standalone (-D) rather than mirroring Apple's inetd-style
# socket activation. It's the exact invocation already known to work here, just
# supervised, and KeepAlive restarts it if it ever dies. Port 22 and the Remote
# Login toggle are left entirely alone.
cat > "$PLIST" <<'PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.colinsteele.sshd-2223</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/sbin/sshd</string>
		<string>-D</string>
		<string>-e</string>
		<string>-p</string>
		<string>2223</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>/var/log/sshd-2223.log</string>
	<key>StandardErrorPath</key>
	<string>/var/log/sshd-2223.log</string>
</dict>
</plist>
PLIST_EOF

chown root:wheel "$PLIST"
chmod 644 "$PLIST"
echo "wrote $PLIST"

# A hand-started sshd from an earlier session still holds the port, and launchd
# can't bind a socket someone else owns. Kill only the LISTENER: sshd forks a
# child per connection, those children are separate pids in ESTABLISHED state and
# are not matched here, so a live SSH session — possibly the very one running
# this script — survives the handover.
for pid in $(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
  echo "stopping stray hand-started listener (pid $pid)"
  kill "$pid" 2>/dev/null || true
done

launchctl bootout system "$PLIST" 2>/dev/null || true
launchctl bootstrap system "$PLIST"

# netstat, not lsof: see the note on isPortListening in local-status.ts.
for _ in 1 2 3 4 5; do
  if netstat -an -p tcp | awk '$6 == "LISTEN"' | grep -q "\.${PORT}[[:space:]]"; then
    echo "ok — sshd listening on ${PORT}, and will be at every boot"
    exit 0
  fi
  sleep 1
done

echo "FAILED — nothing listening on ${PORT}; see /var/log/sshd-2223.log" >&2
exit 1
