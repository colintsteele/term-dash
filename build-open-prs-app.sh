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

[ -x "$TERMDASH" ] || { echo "missing or non-executable: $TERMDASH" >&2; exit 1; }

# build_app <app path> <open-prs argument, or empty for the whole pane>
# Three apps: the whole pane, plus one per column for the per-column ⧉ links
# (a hyperlink can't carry arguments, so each column needs its own bundle).
build_app() {
  local app="$1" arg="$2" src
  src=$(mktemp -t open-prs).applescript

  # PATH is set explicitly because `do shell script` runs with a bare
  # /usr/bin:/bin:/usr/sbin:/sbin — no /opt/homebrew/bin, so no tmux, which
  # open_prs needs for its status-line message.
  #
  # errNum -128 is "user cancelled" and passes in silence. Anything else gets an
  # alert, because the alternative is a click that appears to do nothing.
  cat > "$src" <<'OSA'
on run
	try
		do shell script "PATH=/opt/homebrew/bin:/usr/local/bin:$PATH '__TERMDASH__' open-prs __ARG__"
	on error errMsg number errNum
		if errNum is not -128 then
			display alert "Couldn't open PRs" message errMsg as critical
		end if
	end try
end run
OSA
  /usr/bin/sed -i '' -e "s|__TERMDASH__|$TERMDASH|" -e "s|__ARG__|$arg|" "$src"

  mkdir -p "$HOME/Applications"
  rm -rf "$app"
  /usr/bin/osacompile -o "$app" "$src"
  rm -f "$src"

  # Ad-hoc signature, same reasoning as build-ssh-app.sh: it keeps the bundle's
  # identity stable across rebuilds so macOS doesn't treat each build as a new app.
  codesign --force --sign - "$app"

  echo "built $app"
}

build_app "$HOME/Applications/Open PRs.app" ""
build_app "$HOME/Applications/Open PRs (left).app" left
build_app "$HOME/Applications/Open PRs (right).app" right
