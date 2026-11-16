#!/bin/zsh
# todo-add.sh — add one item to the Notion to-do list, from a URL.
#
# The handler behind `termdash-todo:` (see build-todo-app.sh). The morning
# brief is a file:// page with no network — it cannot call Notion itself, and
# baking NOTION_TOKEN into today.html would put a secret in ~/.cache. So each
# row's button is a link, LaunchServices routes the scheme to the app, and the
# app runs this.
#
#   todo-add.sh 'termdash-todo://add?text=Review%20PR%20%2337397'
#
# It appends via `notion-todo.ts --add`, which is the SAME path the
# interactive pane uses — so the week-rollover rule (new M/D heading on a new
# week, see notion-week.ts) has exactly one implementation. Posting to the
# Notion API from here instead would be a second place to forget about it.
set -uo pipefail

DASH="${0:A:h}"
LOG="$HOME/.cache/termdash/todo-add.log"
/bin/mkdir -p "${LOG:h}"

say() { print -r -- "$(date '+%F %H:%M:%S') $*" >> "$LOG" }

# Notified through macOS rather than printed: the caller is a URL handler with
# no terminal, and a click that appears to do nothing is the worst outcome.
notify() {
  /usr/bin/osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1
}

URL="${1:-}"
[[ -n "$URL" ]] || { say "FAIL: no URL"; notify "To-do not added" "No URL given"; exit 1 }
say "--- $URL"

# ── pull the text out ───────────────────────────────────────────────────────
# Percent-decoding in zsh, no python start-up cost: `+` is a space in a query
# string, and ${(#)...} turns a hex escape into its character. Printed via %b
# so the \x sequences are interpreted rather than shown.
query="${URL#*\?}"
raw=""
for pair in ${(s:&:)query}; do
  [[ "$pair" == text=* ]] && raw="${pair#text=}"
done
[[ -n "$raw" ]] || { say "FAIL: no text= in $URL"; notify "To-do not added" "That link had no text"; exit 1 }

raw="${raw//+/ }"
TEXT=$(printf '%b' "${raw//\%/\\x}")

# A URL can carry anything; Notion gets one line. Trim and collapse, and cap
# it — a 2,000-character to-do is a paste accident, not a task.
TEXT="${TEXT//$'\n'/ }"
TEXT="${${TEXT##[[:space:]]##}%%[[:space:]]##}"
[[ -n "$TEXT" ]] || { say "FAIL: text decoded to nothing"; notify "To-do not added" "Empty text"; exit 1 }
(( ${#TEXT} > 500 )) && TEXT="${TEXT[1,500]}…"
# Logged before the credential check, so a decoding problem is visible even
# when the append never gets attempted.
say "text: $TEXT"

# ── append ──────────────────────────────────────────────────────────────────
# Credentials come from keys.zsh, which `do shell script` does not source —
# it runs a bare /bin/sh with none of the login environment.
if [[ -z "${NOTION_TOKEN:-}" || -z "${NOTION_PAGE_ID:-}" ]]; then
  [[ -f "$HOME/.zsh-sources/keys.zsh" ]] && source "$HOME/.zsh-sources/keys.zsh"
fi
if [[ -z "${NOTION_TOKEN:-}" || -z "${NOTION_PAGE_ID:-}" ]]; then
  say "FAIL: NOTION_TOKEN / NOTION_PAGE_ID not set"
  notify "To-do not added" "Notion credentials are not set"
  exit 1
fi

OUT=$( cd "$DASH" && PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" \
  npx tsx notion-todo.ts --add "$TEXT" 2>&1 )
RC=$?
say "rc=$RC $OUT"

if (( RC == 0 )); then
  notify "Added to Notion" "$TEXT"
else
  notify "To-do not added" "${OUT:-unknown error}"
  exit 1
fi
