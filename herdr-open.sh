#!/bin/zsh
# herdr-open — focus (or create) the Herdr Space for a git worktree.
#
# Called by HerdrOpen.app (see build-herdr-open-app.sh) on a cmd-click of the
# branch name in the worktrees panel, so clicking a row in term-dash takes you to
# that worktree's Space in Herdr.
#
# usage:
#   herdr-open.sh /path/to/worktree                  # handy for testing
#   herdr-open.sh 'herdr-space:///path/to/worktree'  # what the .app passes in
#   herdr-open.sh --dry-run <either>                 # print the decision, touch nothing
#
# Exits non-zero only on a usage error or an unresolvable path: a click must never
# silently do nothing, so every other failure ends in a Herdr notification.
#
# Absolute paths throughout. `do shell script` runs with a bare
# /usr/bin:/bin:/usr/sbin:/sbin — none of ~/.zshrc's additions — so a bare `jq`
# or `git` would not resolve here. Same constraint space-target.zsh documents.

emulate -L zsh
set -o pipefail

HERDR="$HOME/.local/bin/herdr"
JQ=/usr/bin/jq
GIT=/usr/bin/git
OSASCRIPT=/usr/bin/osascript

DRY=0
if [[ "$1" == "--dry-run" ]]; then DRY=1; shift; fi
[[ -n "$1" ]] || { print -u2 "usage: herdr-open.sh [--dry-run] <path | herdr-space://path>"; exit 64 }

notify() { (( DRY )) && return 0; "$HERDR" notification show "$1" --body "$2" --position top-right >/dev/null 2>&1 }

# ---- 1. decode the payload -------------------------------------------------
# The scheme is herdr-space://<abs path>, which with a leading-slash path reads
# as herdr-space:///Users/... — the path sits in the URL's PATH component, not
# its HOST. That is deliberate: NSURL lowercases a host, and a lowercased
# /users/colinsteele/code/... no longer string-matches the paths Herdr reports,
# even though APFS would happily open it.
target="$1"
if [[ "$target" == herdr-space://* ]]; then
  target="${target#herdr-space://}"
  if [[ -x /usr/bin/python3 ]]; then
    target="$(/usr/bin/python3 -c 'import sys,urllib.parse; print(urllib.parse.unquote(sys.argv[1]))' "$target")"
  else
    # zsh-only fallback (no python3): %XX → \xXX and let printf expand it.
    target="$(printf '%b' "${target//\%/\\x}")"
  fi
fi

# ---- 2. normalise to a worktree root ---------------------------------------
# cursor-status.ts already emits the checkout root, but resolving anyway means a
# path pasted by hand from inside a subdirectory still works — and it is what
# makes the string compare in step 3 trustworthy.
root=$("$GIT" -C "$target" rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$root" ]]; then
  notify "Not a worktree" "$target is not inside a git checkout."
  print -u2 "herdr-open: not a git worktree: $target"
  exit 1
fi

# ---- 3. does Herdr already have a Space for it? ----------------------------
# `worktree list` carries open_workspace_id per checkout — the join term-dash and
# Herdr share is the DIRECTORY PATH, which is why this needs no state of its own.
# Empty/absent means the checkout exists on disk but has no Space open.
#
# --cwd is NOT optional. Without it `worktree list` answers for whatever repo the
# CALLER happens to be sitting in — run from ~/Code/term-dash it returned
# hubdiff-native's worktrees, so every popmenu row looked like it had no Space and
# every click would have created a duplicate one.
ws=$("$HERDR" worktree list --cwd "$root" 2>/dev/null \
  | "$JQ" -r --arg p "$root" '.result.worktrees[]? | select(.path == $p) | .open_workspace_id // empty' \
  | /usr/bin/head -1)

if (( DRY )); then
  if [[ -n "$ws" ]]; then
    print "focus existing Space $ws  ($root)"
  else
    print "create + focus new Space   ($root)"
  fi
else
  if [[ -n "$ws" ]]; then
    "$HERDR" workspace focus "$ws" >/dev/null 2>&1
  else
    # --focus so the new Space is the one you land in. Creating a Space you then
    # have to go find is a worse outcome than not creating one at all.
    "$HERDR" worktree open --path "$root" --focus >/dev/null 2>&1 \
      || { notify "Couldn't open" "herdr worktree open failed for ${root:t}."; exit 1 }
  fi
fi

# ---- 4. raise the terminal Herdr is running in ------------------------------
# Switching the Space over the socket API changes what Herdr DRAWS; it does not
# bring Herdr's window forward. Without this the click looks like it did nothing,
# because term-dash's own iTerm window is still in front of it.
#
# Herdr is a TUI, so the thing to raise is the iTerm session whose tty belongs to
# a herdr CLIENT process. The server (`herdr server`) has no tty and is filtered
# out by that alone. With more than one client attached this takes the
# lowest-pid one; set HERDR_TTY=/dev/ttysNNN to pin a specific one.
tty_target="${HERDR_TTY:-$(/bin/ps -Ao pid=,tty=,comm= \
  | /usr/bin/awk '$2 != "??" && $3 ~ /(^|\/)herdr$/ { print "/dev/" $2; exit }')}"

if (( DRY )); then
  print "raise ${tty_target:-<no herdr client tty found>}"
  exit 0
fi

if [[ -n "$tty_target" ]]; then
  # Select window AND tab AND session: selecting only the session leaves it
  # behind whatever tab is fronted in that window.
  "$OSASCRIPT" - "$tty_target" <<'OSA' >/dev/null 2>&1 || /usr/bin/open -a iTerm
on run argv
	set wantedTTY to item 1 of argv
	tell application "iTerm2"
		repeat with w in windows
			repeat with t in tabs of w
				repeat with s in sessions of t
					if (tty of s) is wantedTTY then
						select w
						select t
						select s
						activate
						return
					end if
				end repeat
			end repeat
		end repeat
	end tell
	tell application "iTerm2" to activate
end run
OSA
else
  # Herdr is not running anywhere we can see. Say so rather than raising an
  # arbitrary iTerm window.
  print -u2 "herdr-open: no attached herdr client found; Space focused but nothing to raise"
fi
