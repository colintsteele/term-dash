#!/usr/bin/env bash
# Build "~/Applications/TermDashToDo.app" — the owner of the `termdash-todo:`
# scheme, and therefore the click target for the "To-do it" buttons in the
# morning brief.
#
# Why an app bundle and not just todo-add.sh: a link in an HTML page carries a
# URI, not a command. LaunchServices dispatches URL schemes to BUNDLES, never
# to scripts — a bare .sh would be opened in an editor. Same constraint as
# build-herdr-open-app.sh, build-ssh-app.sh and TermDashOpen.app.
#
# Why a scheme at all: brief-html.ts writes ONE self-contained file:// page
# with no network, deliberately. It cannot POST to Notion (CORS forbids it
# from a file:// origin) and must not carry NOTION_TOKEN, which would put a
# secret in ~/.cache/termdash/today.html. A link is the only thing a static
# local page can use to make something happen.
#
# The app is a four-line shim; all the behaviour is in todo-add.sh, so it can
# be edited without recompiling anything.
set -euo pipefail
cd "$(dirname "$0")"

SCRIPT_PATH="$PWD/todo-add.sh"
APP="$HOME/Applications/TermDashToDo.app"
PLIST="$APP/Contents/Info.plist"

[ -x "$SCRIPT_PATH" ] || { echo "missing or non-executable: $SCRIPT_PATH" >&2; exit 1; }

SRC=$(mktemp -t termdash-todo).applescript
trap 'rm -f "$SRC"' EXIT

# $HOME stays unexpanded in the AppleScript source (note the quoted heredoc) —
# `do shell script` runs the string through /bin/sh, which expands it then.
#
# errNum -128 is "user cancelled" and passes in silence. Anything else gets an
# alert: todo-add.sh already posts a macOS notification for the failures it can
# name, so reaching here means something more basic went wrong.
cat > "$SRC" <<'OSA'
on open location this_URL
	try
		do shell script "$HOME/Code/term-dash/todo-add.sh " & quoted form of this_URL
	on error errMsg number errNum
		if errNum is not -128 then
			display alert "Couldn't add the to-do" message errMsg as critical
		end if
	end try
end open location
OSA

mkdir -p "$HOME/Applications"
rm -rf "$APP"
/usr/bin/osacompile -o "$APP" "$SRC"

# Declare the scheme. osacompile writes a plain applet Info.plist with no URL
# types at all, so this is what makes LaunchServices route termdash-todo: here.
/usr/libexec/PlistBuddy \
  -c 'Add :CFBundleURLTypes array' \
  -c 'Add :CFBundleURLTypes:0 dict' \
  -c 'Add :CFBundleURLTypes:0:CFBundleURLName string term-dash notion to-do' \
  -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' \
  -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string termdash-todo' \
  "$PLIST"

# Stable bundle id — osacompile's default is a generic ScriptEditor one, which
# makes every rebuild look like a different app to LaunchServices.
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier local.termdash.notiontodo' "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string local.termdash.notiontodo' "$PLIST"

# Re-sign. DON'T SKIP: osacompile ad-hoc signs the applet and editing
# Info.plist invalidates that signature. Recent macOS then refuses to launch
# the app as "damaged", which presents as a button doing absolutely nothing.
codesign --force --sign - "$APP"

# Register it now rather than waiting for LaunchServices to notice.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP" 2>/dev/null || true

echo "built $APP"
echo "test it with:  open 'termdash-todo://add?text=hello%20from%20the%20app'"
