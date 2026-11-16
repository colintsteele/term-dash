#!/usr/bin/env bash
# Build "~/Applications/HerdrOpen.app" — the owner of the `herdr-space:` scheme,
# and therefore the cmd-click target for branch names in the worktrees panel.
#
# Why an app bundle and not just herdr-open.sh: an OSC-8 hyperlink carries a URI,
# not a command. LaunchServices dispatches URL schemes to BUNDLES, never to
# scripts — a bare .sh would be opened in an editor. Same constraint as
# TermDashOpen.app (tab-reuse.md), build-ssh-app.sh and the Activity Monitor cells
# in local-status.ts.
#
# The app is a four-line shim; all the logic lives in herdr-open.sh, so behavior
# can be edited without recompiling anything.
set -euo pipefail
cd "$(dirname "$0")"

SCRIPT_PATH="$PWD/herdr-open.sh"
APP="$HOME/Applications/HerdrOpen.app"
PLIST="$APP/Contents/Info.plist"

[ -x "$SCRIPT_PATH" ] || { echo "missing or non-executable: $SCRIPT_PATH" >&2; exit 1; }

SRC=$(mktemp -t herdr-open).applescript
trap 'rm -f "$SRC"' EXIT

# $HOME stays unexpanded in the AppleScript source (note the quoted heredoc) —
# `do shell script` runs the string through /bin/sh, which expands it then.
#
# errNum -128 is "user cancelled" and passes in silence. Anything else gets an
# alert: herdr-open.sh already notifies through Herdr for the failures it can
# name, so reaching here means something more basic went wrong and a click that
# appears to do nothing is the worst possible answer.
cat > "$SRC" <<'OSA'
on open location this_URL
	try
		do shell script "$HOME/Code/term-dash/herdr-open.sh " & quoted form of this_URL
	on error errMsg number errNum
		if errNum is not -128 then
			display alert "Couldn't open the Herdr Space" message errMsg as critical
		end if
	end try
end open location
OSA

mkdir -p "$HOME/Applications"
rm -rf "$APP"
/usr/bin/osacompile -o "$APP" "$SRC"

# Declare the scheme. osacompile writes a plain applet Info.plist with no URL
# types at all, so this is what makes LaunchServices route herdr-space: here.
/usr/libexec/PlistBuddy \
  -c 'Add :CFBundleURLTypes array' \
  -c 'Add :CFBundleURLTypes:0 dict' \
  -c 'Add :CFBundleURLTypes:0:CFBundleURLName string term-dash herdr space' \
  -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' \
  -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string herdr-space' \
  "$PLIST"

# Stable bundle id — osacompile's default is a generic ScriptEditor one, which
# makes every rebuild look like a different app to LaunchServices.
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier local.termdash.herdropen' "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string local.termdash.herdropen' "$PLIST"

# Re-sign. DON'T SKIP: osacompile ad-hoc signs the applet and editing Info.plist
# invalidates that signature. Recent macOS then refuses to launch the app as
# "damaged", which presents as a herdr-space: click doing absolutely nothing.
codesign --force --deep -s - "$APP"

LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -f "$APP"

echo "built $APP"
echo "test: open 'herdr-space://$PWD'"
