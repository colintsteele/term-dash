#!/bin/zsh
# tab-open — focus an EXISTING Chrome tab instead of piling up duplicates.
#
# Called by the TermDashOpen.app URL-scheme handler (see tab-reuse.md) with the
# clicked link, so a cmd-click in the worktrees panel reuses the tab you already
# have open for that PR / story / workflow / diff.
#
# usage:
#   tab-open.sh <url>                     # plain https://… (handy for testing)
#   tab-open.sh 'termdash:https%3A%2F%2F…' # what the .app passes in
#   tab-open.sh --dry-run <url>           # print the decision, touch nothing
#
# Exits non-zero only on a usage error: if Chrome scripting fails we fall back to
# `open`, so a click NEVER silently does nothing.

emulate -L zsh
set -o pipefail

DRY=0
if [[ "$1" == "--dry-run" ]]; then DRY=1; shift; fi
[[ -n "$1" ]] || { print -u2 "usage: tab-open.sh [--dry-run] <url>"; exit 64; }

# ---- 1. decode the payload -------------------------------------------------
# The .app receives `termdash:<percent-encoded real url>`. Percent-encoding the
# inner URL keeps LaunchServices/NSURL from reinterpreting its ? and # as the
# OUTER url's query/fragment, which is what mangles a nested raw URL.
#
# Absolute paths throughout: when TermDashOpen.app invokes us via `do shell
# script`, PATH is a bare /usr/bin:/bin:/usr/sbin:/sbin with none of ~/.zshrc's
# additions — a bare `python3`/`osascript` would resolve here but not everywhere,
# so don't rely on it.
url="$1"
if [[ "$url" == termdash:* ]]; then
  url="${url#termdash:}"
  if [[ -x /usr/bin/python3 ]]; then
    url="$(/usr/bin/python3 -c 'import sys,urllib.parse; print(urllib.parse.unquote(sys.argv[1]))' "$url")"
  else
    # zsh-only fallback (no python3): %XX → \xXX and let printf expand it.
    url="$(printf '%b' "${url//\%/\\x}")"
  fi
fi

# ---- 2. per-site match key + mode -----------------------------------------
# WHY a key and not the URL itself: the tab you have open is almost never the URL
# term-dash emitted. Shortcut appends the story slug and view params
# (/story/171947 → /story/171947/remove-shortcut-…?vc_group_by=day), GitHub adds
# review anchors (/pull/35106#pullrequestreview-…), and term-dash's ⎇ link is
# sometimes a /pulls?q=is:pr+head:… SEARCH url that redirects to /pull/<n>. So we
# match on the shortest stable prefix that identifies the THING, not the URL.
#
# mode=singleton → one tab for this app, forever: reuse it and repoint its URL.
# mode=focus     → this thing gets its own tab: focus if open, else a new tab.
# mode=anchor    → focus, and additionally scroll to the clicked #fragment when
#                  that's all that differs from where the tab already is. A
#                  fragment-only URL change is a SAME-DOCUMENT navigation, so the
#                  browser just scrolls: no reload, no lost scroll position, no
#                  lost in-progress review. This is what plain focus mode gave up
#                  — a comment permalink landed on the PR without going to the
#                  comment. Chrome's `execute javascript` could scroll too, but
#                  it's off behind View > Developer > Allow JavaScript from Apple
#                  Events, and requiring that of anyone installing this is worse.
#
# style is HOW the key is compared against a tab's URL:
#   prefix   → tab URL starts with the key. Fine when the site only ever APPENDS
#              to what we emit (hubdiff's ?repo=).
#   boundary → key, or key followed by one of # ? / & . Same idea as prefix but
#              refuses to match a longer id: plain prefix would let a click on
#              /pull/35106 focus a tab sitting on /pull/351060.
#   contains → every token (split on |) appears anywhere in the tab URL. For
#              sites that RESTRUCTURE the URL after load, where no prefix of what
#              we emit survives — see the CircleCI note below.
mode=focus
style=prefix
case "$url" in
  # hubdiff shows one repo at a time and holds no state worth preserving, so a
  # second tab is pure noise → keep exactly one and re-point it per worktree.
  http://hubdiff.localhost/*|https://hubdiff.localhost/*)
    key="$(/usr/bin/sed -E 's#^(https?://hubdiff\.localhost/).*#\1#' <<< "$url")"
    mode=singleton ;;
  # A story/PR/workflow tab holds scroll position, expanded diffs, maybe an
  # in-progress review — never blow that away with a real navigation.
  https://app.shortcut.com/*/story/*)
    key="$(/usr/bin/sed -E 's#^(https://app\.shortcut\.com/[^/]+/story/[0-9]+).*#\1#' <<< "$url")"
    style=boundary ;;
  # Every git-notiql badge on a PR keys to the same /pull/<n>, so they share one
  # tab — but each badge points at its own #discussion_r… comment, so anchor mode
  # scrolls there. The ⎇ glyph shares this rule and carries no fragment, which is
  # exactly why anchor mode only acts when the TARGET has one: clicking ⎇ must not
  # yank a tab you're reading back up to the top of the PR.
  https://github.com/*/pull/*)
    key="$(/usr/bin/sed -E 's#^(https://github\.com/[^/]+/[^/]+/pull/[0-9]+).*#\1#' <<< "$url")"
    style=boundary
    mode=anchor ;;
  # The ⎇ glyph's fallback shape: a head-ref SEARCH url, used until `gh pr list`
  # resolves a /pull/<n> — and used forever on a branch that has no PR yet. Can't
  # key it on the PR number (there isn't one), and can't prefix-match it either:
  # GitHub re-encodes the query (our %20 comes back as +). So match two tokens —
  # the repo's /pulls path to anchor the domain, and the branch's last segment,
  # which has no characters that survive encoding differently.
  #
  # Once `gh` resolves, the key becomes …/pull/<n> and no longer matches this
  # search tab, so the click correctly moves to the real PR rather than sticking
  # to the search results.
  https://github.com/*/pulls\?q=*)
    base="$(/usr/bin/sed -E 's#^(https://github\.com/[^/]+/[^/]+/pulls).*#\1#' <<< "$url")"
    tail="$(/usr/bin/sed -E 's#.*(%2F|%3A)([^%&]+)$#\2#' <<< "$url")"
    if [[ -n "$tail" && "$tail" != "$url" ]]; then
      key="$base|$tail"
      style=contains
    else
      key="$url"
    fi ;;
  # CircleCI is the one site where prefix matching CANNOT work. Its SPA rewrites
  # the deep link on load:
  #   emitted  …/pipelines/gh/Popmenu/popmenu/223260/workflows/<uuid>
  #   settles  …/pipelines/gh/Popmenu/popmenu/223260/details?workflowId=<uuid>
  # `/workflows/<uuid>` becomes `/details?workflowId=<uuid>`, so no prefix of the
  # emitted URL survives and every click stacked another tab (found three
  # identical ones open while debugging this). The workflow UUID is the only
  # stable token in BOTH forms, so match on that instead.
  https://app.circleci.com/pipelines/*/workflows/*)
    key="$(/usr/bin/sed -E 's#^.*/workflows/([0-9a-fA-F-]+).*#\1#' <<< "$url")"
    # A job link is a different thing from its workflow, so pin it to the job
    # number too. Matching the bare number rather than the `/jobs/<n>` path
    # because CircleCI may well restructure that segment the same way it does
    # `/workflows/` — the number survives either shape. UNVERIFIED against a real
    # click: no branch has had a failing build to click through.
    [[ "$url" == */jobs/* ]] &&
      key="$key|$(/usr/bin/sed -E 's#^.*/jobs/([0-9]+).*#\1#' <<< "$url")"
    style=contains ;;
  # Anything else (incl. the /pulls?q=… search fallback) matches only itself.
  *) key="$url" ;;
esac

if (( DRY )); then
  print "url:   $url"
  print "key:   $key"
  print "mode:  $mode"
  print "style: $style"
fi

# ---- 3. find-or-open in Chrome --------------------------------------------
# Two passes on purpose: an EXACT url match wins over a prefix match, so clicking
# the ● workflow dot lands on the workflow tab rather than a /jobs/<n> tab that
# merely starts with the same key.
read -r -d '' script <<'APPLESCRIPT'
on run argv
  set target to item 1 of argv
  set matchKey to item 2 of argv
  set repoint to (item 3 of argv is "singleton")
  set anchorMode to (item 3 of argv is "anchor")
  set matchStyle to item 4 of argv
  set dryRun to (item 5 of argv is "dry")

  -- `contains` keys carry several tokens joined by "|"; every one must appear.
  set AppleScript's text item delimiters to "|"
  set tokens to text items of matchKey
  set AppleScript's text item delimiters to ""

  tell application "Google Chrome"
    repeat with pass from 1 to 2
      repeat with w in windows
        set i to 0
        repeat with t in tabs of w
          set i to i + 1
          set u to URL of t
          set hit to false
          if pass is 1 then
            if u is target then set hit to true
          else if matchStyle is "contains" then
            set hit to true
            repeat with tok in tokens
              if u does not contain (tok as text) then set hit to false
            end repeat
          else if matchStyle is "boundary" then
            if u is matchKey then
              set hit to true
            else
              repeat with sep in {"#", "?", "/", "&"}
                if u starts with (matchKey & (sep as text)) then set hit to true
              end repeat
            end if
          else
            if u starts with matchKey then set hit to true
          end if
          if hit then
            -- Same-document scroll: only when the click carries a #fragment and
            -- the tab is already on that exact page. Any other difference would
            -- be a real navigation, which is the state loss we're avoiding.
            set willScroll to false
            if anchorMode and target contains "#" and u is not target then
              if my dropFragment(u) is my dropFragment(target) then set willScroll to true
            end if
            if dryRun then
              if willScroll then return "would focus + scroll to anchor (pass " & pass & "): " & u
              return "would focus (pass " & pass & "): " & u
            end if
            if repoint or willScroll then set URL of t to target
            set active tab index of w to i
            set index of w to 1
            activate
            return "focused: " & u
          end if
        end repeat
      end repeat
    end repeat

    if dryRun then return "would open a new tab"
    if (count of windows) is 0 then
      make new window
      set URL of active tab of window 1 to target
    else
      tell window 1 to make new tab with properties {URL:target}
      set index of window 1 to 1
    end if
    activate
    return "opened new tab"
  end tell
end run

on dropFragment(u)
  set AppleScript's text item delimiters to "#"
  set base to text item 1 of u
  set AppleScript's text item delimiters to ""
  return base
end dropFragment
APPLESCRIPT

dryflag=live
(( DRY )) && dryflag=dry

if ! /usr/bin/osascript -e "$script" "$url" "$key" "$mode" "$style" "$dryflag" 2>/tmp/tab-open.err; then
  # Chrome not running, automation permission denied, AppleScript error — never
  # swallow the click; hand it to LaunchServices so it opens SOMEWHERE.
  print -u2 "tab-open: chrome scripting failed, falling back to open: $(</tmp/tab-open.err)"
  (( DRY )) || /usr/bin/open "$url"
fi
