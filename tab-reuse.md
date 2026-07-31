# Reusing browser tabs instead of piling up duplicates

**Status: installed and working on this machine.**
`~/Applications/TermDashOpen.app` owns the `termdash:` scheme,
[`tab-open.sh`](./tab-open.sh) is the handler, `cursor-status.ts` **and
`git-notiql.ts`** route their http links through `webLink()`, and
`TERMDASH_REUSE_TABS=1` is exported from `~/.zsh-sources/exports.zsh`. Verified
end to end — see [Verification](#verification). The [Install](#install) steps are kept as the
record of how it was built (and to redo it on another machine);
[Uninstall](#uninstall) backs it all out.

## The problem

Every cmd-click in the worktrees panel opens a **new** Chrome tab, even when the
thing you clicked is already open. Click the `±` on three worktrees and you get
three hubdiff tabs; click the same PR twice and you get two.

## Why this needs a helper app

An OSC 8 hyperlink can carry exactly one thing: a URI.

```
ESC ]8;; <url> ESC \  <text>  ESC ]8;; ESC \
```

There is no field for "reuse a tab" — the sequence has no room for intent. iTerm2
just hands the URL to LaunchServices, and Chrome's LaunchServices entry point
unconditionally opens a new tab. Nothing in the terminal, the escape sequence, or
Chrome's CLI can change that.

What *can* change it is AppleScript: Chrome exposes `windows`/`tabs`, their URLs,
and `active tab index`, so a script can find an open tab and focus it. So the
chain has to be:

```
cmd-click  →  termdash:<pct-encoded url>   (a scheme WE own)
           →  LaunchServices → TermDashOpen.app   (on open location)
           →  tab-open.sh → osascript → Chrome: find-or-focus
```

The `.app` exists only to own the scheme — LaunchServices dispatches URL schemes
to bundles, not to scripts, so a bare shell script can't be the handler. It's a
five-line AppleScript shim; all the logic lives in `tab-open.sh`, so you can edit
behavior without recompiling.

### Why the payload is percent-encoded

`termdash:` carries a whole URL, and the inner URL has its own `?` and `#`. Nested
raw, `NSURL` parses the *inner* `?tab=files#r123` as the *outer* URL's query and
fragment and the payload gets mangled. Percent-encoding the inner URL
(`encodeURIComponent` out, `urllib.parse.unquote` back) makes it one opaque
component. Verified round-trip, `#` and `?` intact:

```
in:  https://github.com/Popmenu/popmenu/pull/35106?tab=files#r123
out: https://github.com/Popmenu/popmenu/pull/35106?tab=files#r123   ✓
```

## The non-obvious part: match on a key, not the URL

The naive implementation compares the clicked URL to each tab's URL. **That
almost never matches**, because the tab you have open is rarely the URL term-dash
emitted — the site rewrote it after you landed:

| term-dash emits | what's actually in your tab | why |
|---|---|---|
| `/story/171947` | `/story/171947/remove-shortcut-skill-rails-service-files?vc_group_by=day&ct_workflow=all&…` | Shortcut appends the slug + your view params |
| `/pull/35106` | `/pull/35106#pullrequestreview-4787266436` | GitHub anchors the review you last read |
| `?repo=<path A>` | `?repo=<path B>` | same app, different worktree |

(The `⎇` PR link has a worse version of this problem — the URL term-dash emits
changes over the widget's own lifetime — which needs
[two keys rather than one](#the--pr-link-needs-two-keys).)

So we match on the shortest prefix that identifies **the thing**, then decide what
to do with it:

| Link | Match key | Style | Mode | Behavior |
|---|---|---|---|---|
| `±` hubdiff | `http://hubdiff.localhost/` | prefix | **singleton** | reuse the one tab, rewrite `?repo=`, focus |
| `◆` Shortcut | `…/story/<id>` | boundary | focus | focus that story's tab, else new tab |
| `●` CI + failed jobs | the workflow **UUID** (+ job number) | **contains** | focus | focus that workflow's tab, else new tab |
| git-notiql badges | `…/pull/<n>` | boundary | **anchor** | one tab per PR, scrolled to the clicked comment |
| `⎇` PR, resolved | `…/pull/<n>` | boundary | anchor | focus that PR's tab (no fragment → no scroll) |
| `⎇` PR, unresolved | `…/pulls` + branch tail | **contains** | focus | focus the head-ref search tab |
| anything else | the URL itself | prefix | focus | exact match only |

### Three match styles, because sites mangle URLs differently

- **prefix** — the tab URL starts with the key. Enough when the site only ever
  *appends* to what we emit (hubdiff's `?repo=`).
- **boundary** — key, or key followed by one of `#` `?` `/` `&`. Same idea, but
  refuses to match a longer id: plain prefix would let a click on `/pull/35106`
  focus a tab sitting on `/pull/351060`.
- **contains** — every token appears anywhere in the tab URL. Needed when the
  site *restructures* the URL and no prefix survives. Only CircleCI does this.

### CircleCI rewrites the path, so prefix matching cannot work

This is why the `●` dot stacked a new tab on every single click. Its SPA turns
the deep link into a query param on load:

```
emitted   …/pipelines/gh/Popmenu/popmenu/223260/workflows/79624b3b-…
settles   …/pipelines/gh/Popmenu/popmenu/223260/details?workflowId=79624b3b-…
```

`/workflows/<uuid>` becomes `/details?workflowId=<uuid>`. Not one character of
the emitted URL past `223260/` survives, so both passes missed and every click
opened a duplicate — three identical copies were open when this was diagnosed.
The workflow UUID is the only stable token in both forms, so that's the key.

A **new push means a new workflow UUID**, and therefore legitimately a new tab.
This dedupes repeat clicks on the same run, not tabs accumulating across a day of
pushes — matching how `◆` gives each story its own tab.

### The `⎇` PR link needs two keys

`w.prUrl` is not one URL, it's two shapes. On the fast lane it's a
`/pulls?q=is:pr head:<branch>` **search** URL; only once `gh pr list` resolves on
the slow lane does it become the direct `/pull/<n>`. And on a branch with **no PR
yet**, `gh` never resolves anything, so that row keeps the search URL forever.

This link was originally excluded from tab reuse on the theory that one key
couldn't cover both shapes. That was the wrong conclusion — it just needs two,
because the two shapes are genuinely two different destinations:

- resolved → key `…/pull/<n>`, `boundary`
- unresolved → key `…/pulls` + the branch's last path segment, `contains`

`contains` rather than prefix because GitHub re-encodes the query — we emit `%20`
between the search terms and the tab can come back with `+`. The branch tail
(`remove-rollout-flag-marketeers-unsubscribe`) has no characters that encode
differently, and the `/pulls` token anchors the match so a branch name appearing
in some unrelated tab can't collide.

Keying them separately is what makes the feared "sticky search page" a non-issue:
once `gh` resolves, the key becomes `…/pull/<n>`, which does not match the search
tab, so the click moves to the real PR instead of re-focusing stale results.

**singleton vs focus vs anchor** is the distinction that matters. hubdiff renders
one repo at a time and holds no state worth keeping, so a second tab is pure noise
→ keep exactly one and re-point it (**singleton**). A story tab *does* hold state
(scroll position, expanded sections), so it gets its own tab and we only ever
focus it, never rewrite its URL (**focus**).

PR tabs needed a third option. Plain focus mode lost something real: a git-notiql
badge points at one specific `#discussion_r…` comment, and focusing the tab
without touching its URL landed you on the PR but not at the comment — strictly
worse than the duplicate tab it replaced, which at least scrolled to the right
place.

**anchor** mode recovers it for free. A URL change that differs *only* in the
`#fragment` is a same-document navigation: the browser scrolls to the anchor
without refetching, so nothing in the page is lost. Verified by sampling Chrome's
`loading` property across the click — it never went true, and the tab's URL picked
up the new anchor:

```
before: …/pull/34925                              loading=false
t+0.4s: …/pull/34925#issuecomment-5048487338      loading=false
…                                                 (never flips true)
```

The guard is that anchor mode only acts when the **target** carries a fragment and
the tab is already on that exact page. Both halves matter: the `⎇` glyph shares
this rule and carries no fragment, so without the first check, clicking it would
yank a PR you were reading back to the top; without the second, a tab sitting on
`/pull/<n>/files` would get a real navigation and lose the diff view.

Chrome's `execute javascript` could scroll too, but it's off behind *View >
Developer > Allow JavaScript from Apple Events* (confirmed — it errors out until
you enable it), and making that a install prerequisite is worse than the fragment
trick, which needs nothing.

**Two passes, exact before prefix.** A CircleCI job URL starts with its workflow
URL, so a single prefix pass would send a click on the `●` workflow dot to a
`/jobs/<n>` tab. Checking all tabs for an exact match first fixes that.

## Install

Nothing here touches the repo — it's all in `~/Applications` plus one
LaunchServices registration.

### 1. Build the scheme-owning app

```sh
cat > /tmp/TermDashOpen.applescript <<'EOF'
on open location this_URL
	do shell script "$HOME/Code/term-dash/tab-open.sh " & quoted form of this_URL
end open location
EOF

osacompile -o ~/Applications/TermDashOpen.app /tmp/TermDashOpen.applescript
```

`$HOME` stays unexpanded in the AppleScript source (note the quoted heredoc) —
`do shell script` runs the string through `/bin/sh`, which expands it then.

### 2. Declare the `termdash:` scheme

`osacompile` writes a plain applet Info.plist; add the URL type so LaunchServices
routes the scheme to it.

```sh
plist=~/Applications/TermDashOpen.app/Contents/Info.plist
/usr/libexec/PlistBuddy \
  -c 'Add :CFBundleURLTypes array' \
  -c 'Add :CFBundleURLTypes:0 dict' \
  -c 'Add :CFBundleURLTypes:0:CFBundleURLName string term-dash tab reuse' \
  -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array' \
  -c 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string termdash' \
  "$plist"

# give it a stable bundle id (osacompile's default is a generic ScriptEditor one);
# use `Set` instead of `Add` if the key already exists
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier local.termdash.open' "$plist" \
  || /usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string local.termdash.open' "$plist"
```

### 2b. Re-sign the bundle

**Don't skip this.** `osacompile` ad-hoc signs the applet, and editing
`Info.plist` invalidates that signature — recent macOS then refuses to launch the
app ("damaged"), which shows up as a `termdash:` click doing nothing at all.

```sh
codesign --force --deep -s - ~/Applications/TermDashOpen.app
codesign -dv ~/Applications/TermDashOpen.app   # expect: Signature=adhoc
```

### 3. Register and test

```sh
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f ~/Applications/TermDashOpen.app

open "termdash:$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' \
  'https://github.com/Popmenu/popmenu/pull/35106')"
```

Confirm the scheme landed:

```sh
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -dump | grep -A1 'local.termdash.open' | grep 'claimed schemes'
# → claimed schemes:  termdash:
```

**On Automation permission:** macOS may prompt *"TermDashOpen wants to control
Google Chrome"* — allow it; that's the TCC grant the tab lookup needs. It did
*not* prompt during install here, because TCC attributes automation to the
*responsible* process, and the launching terminal already held the grant. So a
click routed through a different parent may still prompt once. If it's ever
denied, the click degrades to a new tab (see the `open` fallback) rather than
failing silently — re-enable under System Settings → Privacy & Security →
Automation.

### 4. Point the widget at the scheme

Done — `cursor-status.ts` has `webLink()` beside `link()`:

```ts
// Route http(s) links through the termdash: scheme so a click reuses an existing
// Chrome tab (see tab-reuse.md). OFF unless TermDashOpen.app is installed —
// without the handler, a termdash: link silently does nothing, so this stays
// opt-in for anyone else cloning the repo. cursor:// links are NOT wrapped: they
// go to Cursor, and ?windowId=_blank deliberately forces a new window.
const REUSE_TABS = process.env.TERMDASH_REUSE_TABS === "1";

function webLink(text: string, url: string): string {
  return link(text, REUSE_TABS ? `termdash:${encodeURIComponent(url)}` : url);
}
```

Every http call site uses it — the `●` CI dot, the `⎿` failed-job lines, the `◆`
story glyph, the `±` hubdiff glyph, `gitGlyph`'s `⎇`/`↥`, and both link sites in
`git-notiql.ts`. One call site deliberately keeps bare `link()`:

- **`nameLink`** — a `cursor://` URL whose `?windowId=_blank` exists precisely to
  force a *new* window.

`TERMDASH_REUSE_TABS=1` is exported from `~/.zsh-sources/exports.zsh` (beside the
other term-dash tokens). tmux panes only inherit env vars present when the session
starts, so a running dashboard needs `termdash restart` from a fresh shell to pick
it up.

## Verification

`tab-open.sh --dry-run <url>` prints the decision and touches nothing — the way to
debug a rule without disturbing your browser.

**Matching rules**, dry-run against real open tabs:

| Case | Result |
|---|---|
| hubdiff, same worktree as an open tab | `would focus (pass 1)` — exact hit |
| hubdiff, **different** worktree | `would focus (pass 2)` + repoint — the whole point |
| `/story/171947` vs tab with slug + `?vc_group_by=day…` | `would focus (pass 2)` |
| `/story/999999` (not open) | `would open a new tab` |
| `●` workflow vs tab rewritten to `/details?workflowId=…` | `would focus (pass 2)` — the CircleCI fix |
| `⎿` job link, that job not open | `would open a new tab` |
| PR comment permalink `…/pull/35106#discussion_r999` | `would focus (pass 2)` the `#pullrequestreview-…` tab |
| `/story/1719470` vs a `/story/171947` tab | `would open a new tab` — boundary refuses the longer id |
| `/pull/351060` vs a `/pull/35106` tab | `would open a new tab` — same |

The `/story/…` row is the one that would fail under exact-URL matching; the two
longer-id rows are what `boundary` buys over plain `prefix`.

**The live chain**, clicking for real through LaunchServices:

| Test | Result |
|---|---|
| `open termdash:…hubdiff…?repo=<different worktree>` | **no new tab**; the existing hubdiff tab was repointed to the new `?repo=` |
| `open termdash:…/pull/35106` with that PR already open | focused in ~1s; tab count stayed **1**, anchor intact |
| widget output with `TERMDASH_REUSE_TABS=1` | hubdiff / story / CI links wrapped as `termdash:`; GitHub + `cursor://` left plain |
| double-encoding round-trip (`%2F` → `%252F` → `%2F`) | decoded to exactly the original URL, one layer stripped |
| `open termdash:…/workflows/79624b3b-…` with that run already open | **no new tab** — workflow-tab count held at 3 before and after |
| `⎇` search shape clicked **twice** from cold | 0 → 1 → **1** tab; before the fix the second click made a second tab |
| `⎇` resolved `…/pull/34925` with that PR open | **no new tab** — count held at 2 |
| badge `…/pull/34925#issuecomment-…` onto a tab at `…/pull/34925` | URL gained the anchor, `loading` never went true — scrolled, no reload |

That last one is the subtle one: hubdiff's URL *already* contains `%2F` in its
`?repo=` param, so the wrapped payload carries `%252F`. One `unquote` in the
handler has to strip exactly one layer — verified it does.

## Limitations

- **Chrome only.** Safari has comparable AppleScript support if you swap the
  `tell application` block. Firefox exposes no tab API to AppleScript — it'd need
  a WebExtension instead. Arc already dedupes tabs natively.
- **Never swallows a click.** If Chrome isn't running, the permission is denied,
  or the AppleScript errors, `tab-open.sh` falls back to `open "$url"`, so the
  worst case is today's behavior (a new tab).
- **Clicking the `●` dot when only a job tab is open** focuses the job tab — it
  contains the workflow UUID and no exact match exists.
- **A new push gets a new CI tab.** The key is the workflow UUID, which changes
  every run, so yesterday's workflow tabs linger. Repeat clicks on one run dedupe;
  clicks across runs don't.
- **Re-clicking the same badge doesn't re-scroll.** If the tab's URL already *is*
  the target, there's no navigation to trigger, so if you scrolled away since the
  last click, focusing won't take you back. Nudging it (set the URL to the
  fragment-less form and straight back) would fix it at the risk of a visible
  jump; not done, because it can't be verified without JS access.
- **A comment that isn't in the DOM won't scroll to.** On a long PR, GitHub
  paginates the timeline; a fragment nav can only reach an element that's already
  loaded. That's the one case where a real reload would do better than anchor
  mode.
- **The scroll itself is unverified by machine.** The URL change and the absence
  of a reload were both measured; whether GitHub visibly scrolls to the anchor is
  standard browser behavior but was confirmed by eye, not by reading `scrollY`
  (which needs JavaScript-from-Apple-Events turned on).
- **The `⎿` job rule is dry-run only.** No branch has had a failing build to click
  through, so whether CircleCI also restructures job URLs is untested — the key
  matches the bare job number partly to survive that if it does.
- **Existing duplicates are not cleaned up.** singleton mode reuses the *first*
  matching tab; if you already had two hubdiff tabs, you keep two (one of them just
  stops being touched). It prevents new duplicates, it doesn't dedupe history.
- **The CI dot and job links were untestable end to end** — no worktree had a
  failing CircleCI build at install time, so those two rules are verified only by
  dry run, not by a real click.
- **Tabs in other Chrome profiles/windows are searched too**, and focusing one
  raises that window. Scope the `repeat with w in windows` loop if that's not what
  you want.
- **`termdash:` links are dead without the app** — hence the `REUSE_TABS` gate
  defaulting to off.

## Uninstall

```sh
rm -rf ~/Applications/TermDashOpen.app
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -kill -r -domain local -domain user
# remove the TERMDASH_REUSE_TABS export from ~/.zsh-sources/exports.zsh, then:
termdash restart
```

Dropping the env var is on its own enough to get today's behavior back — the
widget emits plain `https://` links again and `webLink()` becomes a passthrough.
There's no code to revert, and leaving the app installed is harmless.
