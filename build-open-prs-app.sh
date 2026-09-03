#!/usr/bin/env bash
# Build "~/Applications/Open PRs.app" — the click target for the ⧉ in the
# git-notiql pane.
#
# Why an app bundle and not just calling the script: an OSC-8 hyperlink carries a
# URI, not a command. The terminal hands it to LaunchServices, which will happily
# *launch an app* but will only ever *open* a .sh in an editor. An app is the one
# click target that can actually run something — same constraint as
# build-ssh-app.sh and the Activity Monitor cells in local-status.ts.
#
# The app is a thin shim: it runs `termdash open-prs`, which reads the PR list
# git-notiql wrote on its last paint and hands the whole lot to the browser.
set -euo pipefail
cd "$(dirname "$0")"

TERMDASH="$PWD/termdash"
APP="$HOME/Applications/Open PRs.app"

[ -x "$TERMDASH" ] || { echo "missing or non-executable: $TERMDASH" >&2; exit 1; }

SRC=$(mktemp -t open-prs).applescript
trap 'rm -f "$SRC"' EXIT

# PATH is set explicitly because `do shell script` runs with a bare
# /usr/bin:/bin:/usr/sbin:/sbin — no /opt/homebrew/bin, so no tmux, which
# open_prs needs for its status-line message.
#
# errNum -128 is "user cancelled" and passes in silence. Anything else gets an
# alert, because the alternative is a click that appears to do nothing.
cat > "$SRC" <<'OSA'
on run
	try
		do shell script "PATH=/opt/homebrew/bin:/usr/local/bin:$PATH '__TERMDASH__' open-prs"
	on error errMsg number errNum
		if errNum is not -128 then
			display alert "Couldn't open PRs" message errMsg as critical
		end if
	end try
end run
OSA
/usr/bin/sed -i '' "s|__TERMDASH__|$TERMDASH|" "$SRC"

mkdir -p "$HOME/Applications"
rm -rf "$APP"
/usr/bin/osacompile -o "$APP" "$SRC"

# Ad-hoc signature, same reasoning as build-ssh-app.sh: it keeps the bundle's
# identity stable across rebuilds so macOS doesn't treat each build as a new app.
codesign --force --sign - "$APP"

echo "built $APP"
