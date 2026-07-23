#!/usr/bin/env bash
# Visual test: can we hide/recolor an OSC-8 hyperlink underline?
# Run it TWICE and eyeball the underlines:
#   1) in a PLAIN iTerm2 tab (no tmux)           -> tests iTerm2 itself
#   2) inside a tmux pane (e.g. a termdash pane)  -> tests tmux passthrough
# Each line is a clickable link (cmd-click still works); only the styling differs.

ESC=$'\033'
URL="https://example.com"

HL_OPEN="${ESC}]8;;${URL}${ESC}\\"   # ESC ]8;; URL ESC \
HL_CLOSE="${ESC}]8;;${ESC}\\"         # ESC ]8;;     ESC \
RESET="${ESC}[0m"

# $1 = leading SGR styling, $2 = label
link() { printf '%s%s%s%s%s\n' "$1" "$HL_OPEN" "$2" "$HL_CLOSE" "$RESET"; }

printf '%s\n' "--- OSC-8 underline styling test (bg = rgb 250,250,250) ---"
link ""                          "1. baseline link (default underline)"
link "${ESC}[24m"                "2. SGR 24  (underline OFF)"
link "${ESC}[4:0m"               "3. SGR 4:0 (underline-style NONE)"
link "${ESC}[58:2::255:0:0m"     "4. SGR 58 underline color = RED   (proves recolor reaches it)"
link "${ESC}[58:2::250:250:250m" "5. SGR 58 underline color = BACKGROUND (the hide attempt)"
link "${ESC}[58:5:231m"          "6. SGR 58 underline color = 256-idx 231 (near-white fallback)"
printf '%s\n' "-----------------------------------------------------------"
printf '%s\n' "Report per line: underline DISAPPEARS, turns RED, or UNCHANGED."
