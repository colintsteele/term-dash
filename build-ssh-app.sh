#!/usr/bin/env bash
# Build "~/Applications/Start SSH 2223.app" — the command-click target for the
# SSH readout in the status strip.
#
# Why an app bundle and not just the shell script: an OSC-8 hyperlink carries a
# URI, not a command. The terminal hands it to LaunchServices, which will happily
# *launch an app* but will only ever *open* a .sh in an editor. An app is the one
# click target that can actually run something — same trick the CPU/MEM cells use
# to launch Activity Monitor.
#
# The app is a thin shim: it calls bin/ssh-2223-up.sh with administrator
# privileges, which is what raises the native macOS password dialog. Nothing here
# holds standing root — no sudoers entry, nothing for a compliance scan to find.
set -euo pipefail
cd "$(dirname "$0")"

SCRIPT="$PWD/bin/ssh-2223-up.sh"
APP="$HOME/Applications/Start SSH 2223.app"

[ -x "$SCRIPT" ] || { echo "missing or non-executable: $SCRIPT" >&2; exit 1; }

SRC=$(mktemp -t start-ssh-2223).applescript
trap 'rm -f "$SRC"' EXIT

# errNum -128 is "user cancelled" — hitting Escape on the password dialog is a
# decision, not a failure, so it passes in silence. Any other error gets an alert,
# because the alternative is a click that appears to do nothing.
cat > "$SRC" <<'OSA'
on run
	try
		do shell script "'__SCRIPT__'" with administrator privileges
	on error errMsg number errNum
		if errNum is not -128 then
			display alert "Couldn't start SSH on 2223" message errMsg as critical
		end if
	end try
end run
OSA
/usr/bin/sed -i '' "s|__SCRIPT__|$SCRIPT|" "$SRC"

mkdir -p "$HOME/Applications"
rm -rf "$APP"
/usr/bin/osacompile -o "$APP" "$SRC"

# Ad-hoc signature, same reasoning as build-nextmeeting.sh: it keeps the bundle's
# identity stable across rebuilds so macOS doesn't treat each build as a brand
# new app.
codesign --force --sign - "$APP"

echo "built $APP"
