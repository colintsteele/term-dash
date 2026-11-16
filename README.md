# term-dash

A glanceable terminal dashboard for a **worktree-per-task** development flow.
One command (`termdash up`) tiles small, self-refreshing TypeScript widgets into
a full-width status strip over a 3-column tmux layout, so the state of everything
you have in flight — branches, CI, AI agents, PRs — sits in one place.

<details open>
<summary><h2>What it does &amp; how it works</h2></summary>

### The problem it solves

Modern flow is **many small branches at once**, each with an AI agent churning
in it. Git worktrees make that cheap: one checkout per task, side by side.

```sh
git worktree add ../popmenu-wt/sc-171002 -b sc-171002/campaign-builder
# open Cursor on that folder, point an agent at it, move to the next one
```

But now you have 5 folders, 5 branches, 5 agents, and 5 CI runs — and no single
place that answers: **which ones need me right now?** That's the gap term-dash
fills.

### The core idea: the worktree is the unit of work

Everything joins on **one key: the directory path.** A task = a worktree = a
folder. That folder is simultaneously:

| Data source | keyed by folder path | gives us |
|---|---|---|
| `git worktree list` | the worktree dir | branch + HEAD |
| CircleCI (`pipeline/mine`) | the branch | CI status |
| `~/.cursor/projects/<encoded-path>/` | encode path: drop leading `/`, `/`→`-` | the agent's transcript |
| `ps` extension-host process | worktree basename | is an agent attached *right now* |
| Cursor SQLite (`state.vscdb`) | the agent session | is it blocked on a question |
| `herdr worktree list` | the checkout path | the worktree's Herdr Space id |
| `herdr-space://<path>` | the abs path | click to jump into that Space |

So a **single row** in the worktrees panel fuses git + CI + agent state, and
clicking it drops you straight into that worktree's Herdr Space. That fusion is
the whole point.

### What you see (the Worktrees panel — `cursor-status.ts`)

```
●     ✓                  master
───────────────────────────────────────────────────────
● ·A  ✓            add brief to eval           ⎇ ◆   ±
● ··  ✓             fix kpi timeout            ⎇ ◆ △ ±
● ··  ·•··         fix social post fk          ⎇ ◆ △ ±
───────────────────────────────────────────────────────
● ··  ·               plan aim 2.0             ⎇     ±
● ··  ·             spike llm table            ⎇     ±
└──┬──┘            └──────┬──────┘             └──┬──┘
 STATUS               THE WORK                 GLYPHS
```

**The row is three blocks, split by what a cell is FOR.** Everything on the left is
a *state you read* — CI dot, approvals, agent. Everything on the right is a
*cmd-click target you act on* — PR, story, Sentry, diff. The name sits between
them. They used to be interleaved (dot, approvals, then the four link glyphs, then
the name, then the agent way out on the right), so the eye had to sort them apart
on every row.

Moving the agent glyph left is what forced a fixed-width slot for it: the glyphs
are 1, 2 and 4 cells wide (`·`, `!!`, and the 4-slot running track `·•··`).
Trailing, ragged width cost nothing. Leading, it would shift the name column on
every row whose agent state differed, so the slot is padded to the widest and the
glyph centred in it.

> **Widget panes run with `SPINNER_OFF=1`.** `~/.zsh-sources/spinner.zsh` paints a
> braille spinner to `/dev/tty` while a foreground command runs — and every widget
> here *is* a foreground command that never exits, so its painter stayed alive for
> the life of the dashboard: ~0.8% CPU per pane, stamping braille over the widget's
> own output 12× a second, and past the spinner's 60s full-width stage doing it at
> `COLUMNS-2` — a 55-cell wave across a 57-column pane. `SPINNER_SKIP` can't catch
> it by name and the spinner's raw-mode check can't either, because a program that
> only writes ANSI never leaves canonical mode; it looks exactly like a slow build.
> `up()` sets the variable via `split-window -e` (see `PANE_ENV`) on the five widget
> panes only — the middle pane is an ordinary prompt and keeps its spinner. It has
> to be pane *environment*, not `VAR=1 cmd`: `preexec` runs in the parent shell
> before the command line executes, so a variable set on that line is set too late.

There is deliberately no CI/agent tally under the rows. Both counts restated what
the rows already show — every `●` and every agent glyph is on screen directly
above — and they cost three rows (two tallies plus the rule dividing them off) in
a pane whose only real constraint is vertical space.

Reading one row, left to right:
- **`●` colored dot** — CI status for that branch: red failed · yellow running · green passed · gray unknown (cmd-click → the CircleCI workflow).
- **`··` / `✓·` / `✓✓` approvals** — how many of the two required approvals the
  PR has. Always two cells wide whatever the count, so it never shifts the name
  column.
- **`A` architecture approval** — when the branch's *committed* diff touches a path
  owned by `@Popmenu/architecture` in CODEOWNERS (migrations, `schema.rb`, Sidekiq
  config, secrets, the security-check allowlists), the **last approval cell stops
  being generic and becomes that specific one**: bold yellow `A` outstanding, green
  `A` once a member of that team has approved. Yellow matches the `◆` qa tier —
  both mean "waiting on somebody who is not you".

  It *takes* a cell rather than adding one, deliberately. The slot has to stay two
  wide or every row's name column shifts under it, and when architecture is on the
  hook that is the gating fact — a second generic approval doesn't merge the PR.

  Computed from CODEOWNERS against the worktree's own git diff, **not** from
  GitHub's `reviewRequests`. That was tried first and rejected: this repo doesn't
  auto-request the team (PR 35906 touches `db/migrate` and its `reviewRequests`
  array is empty), so asking GitHub would report "not needed" on exactly the PRs
  that need it. Reading the diff also means the marker appears before any PR does.

  **Committed changes only** — `<base>...HEAD`, never the working tree. The first
  version unioned in `git diff HEAD` on the theory that an uncommitted migration
  already needs review. In this repo that is wrong and measurably so: a bare
  `rails db:migrate` rewrites `db/schema.rb` as a side effect (the churn
  `pm-schema-reconcile` exists to undo), so three of five worktrees had a dirty
  `schema.rb`, none had committed it, and every one lit the marker. A gate that
  fires on almost every row is not a gate. Needs `gh` with org read scope to tell
  *approved* from *needed*; without it everything gated reads as outstanding,
  which is the safe way to be wrong.
- **`⎇` PR glyph** — cmd-click → the branch's PR. Magenta once the branch is on the
  remote, **desaturated (dim magenta) while it isn't** — no `origin/<branch>`, so
  there's no PR behind the link yet and the click just lands on an empty search.
  Turns into a purple `↥` when the PR is merged (that row is `worktree clean`-able),
  and is plain dim when the repo has no GitHub slug configured. The unpushed test is
  `origin/<branch>` existing, *not* the branch's upstream — `worktree -b` branches
  off `origin/master`, which git's default `branch.autoSetupMerge` records as their
  upstream, so an upstream check would call every fresh worktree "pushed".
- **`△` Sentry glyph** — present *only* on branches that fix a production error.
  Cmd-click → the Sentry issue. Its absence is the signal as much as its presence:
  a row with `△` is a fix, a row without is a feature or a spike, and the summary
  beside it says the same thing in words. Resolved once and cached, not per frame —
  the row has to draw every 5s whether or not Sentry is reachable.
- **`±` diff glyph** — always present. Cmd-click → that worktree's diff in the
  native **Hubdiff.app**, via its own `hubdiff://?repo=<url-encoded worktree path>`
  URL scheme. macOS hands the link to the running app (or launches it) and the
  single window repoints at that worktree. No browser involved: the diff viewer is
  its own app, so it stays out of the one Chrome window everything else shares.

With `TERMDASH_REUSE_TABS=1` and the small handler app from
[`tab-reuse.md`](./tab-reuse.md), the remaining *web* links stop stacking up
duplicate Chrome tabs: `◆`/`●` — plus `⎇` and every badge in the `git-notiql`
pane — focus the tab you already have open for that story / CI run / PR. Opt-in:
without the handler the links behave as plain URLs. `±` no longer goes through it
at all; a `hubdiff:` URL must reach LaunchServices raw to land in the app.
- **repo · branch** — from `git worktree list`. Cmd-click the name → opens/focuses that worktree's Cursor window (see below).
- **agent glyph** — `▸ running · ✓ done · ‼ waiting on you · ✗ error · · none`.
- **age** — how long since the agent's last activity.

Triage in one glance: `‼` and `✗` are where you go; `▸` is working, leave it.

**Every branch shows what it DOES, not what it's called.** The name column carries a
cached 1-2 word action summary in place of the branch name — `defer slack alert`,
`add follower kpis`, `spike llm table`. Only the main checkout is exempt; `master` is
not a unit of work.

This replaced a marquee that scrolled overlong names. The marquee cost a full-panel
repaint every 500ms for as long as one overlong name existed (`render` clears the
screen each frame), which is a flicker you sit next to all day, and the text was only
readable during the ~3s it rested at home. Summaries are static, so a panel with no
running agent now draws once per data tick and holds still.

**Summarising is not renaming.** The branch name is the *weakest* signal about what a
change does — it gets copied from a sibling branch, names the ticket instead of the
work, or goes stale the moment the task shifts. This panel has the counter-example
living in it: two branches off `sc-176097` differ by one token (`…-for-hampton` and
`…-for-hampton-social`) and neither says what either change does. So the summary is
written from the artifacts that do, in this order:

| Evidence | Why |
|---|---|
| Sentry issue | Decides *fix vs feature* outright, and names what is broken. Overrides everything below. |
| PR title + description | A human sentence about the change, written for reviewers. |
| Commit subjects | The same thing before review, and the only signal on a branch with no PR. |
| Worktree directory name | `worktree -b` names it after the branch, but a hand-made worktree is often named for the actual task. A real hint the branch lost. |
| Branch name | The fallback, and the thing the summary exists to improve on. |

Each cache entry records which of those won, as
`from: "sentry" | "pr" | "commits" | "name"`. That is the difference between *this
summary is wrong* and *this branch has nothing to summarise yet* — a `name` row gets
better the moment a PR exists, and `--force` is how you collect that.

**"Add" vs "fix" is a fact, not a wording choice**, and the branch name never carries
it: `follower-kpi-counts-timeout-for-hampton` reads like a feature and is a production
timeout. Two places state it outright, and both are checked:

1. **The worktree directory prefix.** Sentry-driven worktrees here are named
   `<sentry short-id suffix>-<slug>` — `10AF-social-post-fk`, `ZY0-follower-kpi-timeout`.
   This is checked **first and wins**, because it is per-worktree: the two branches off
   `sc-176097` are two *different* Sentry issues (`10AF` and `ZY0`) and the shared
   Shortcut story only names one of them.
2. **The Shortcut story.** A ticket filed from Sentry opens with a literal
   `Sentry Issue: [SHORT-ID](url)` line, and its `story_type` is `bug`.

The directory path needs a guard, since a prefix is just a prefix. A candidate must be
3–6 uppercase alphanumerics **containing at least one digit**, which rejects `AIM`,
`P4` and `LLM` before any request is made — and the API rejects the rest (all three
return 404 when tried). Sentry short ids are only addressable as
`<PROJECT>-<SUFFIX>`, so a bare suffix is tried against each project in
`SENTRY_PROJECT_PREFIXES`.

Once a Sentry issue is attached, the prompt is told plainly that the branch is a fix,
and that this **overrides the PR title** — a PR called "Add Follower Counts to KPI
Metrics" carrying a Sentry timeout is `fix kpi timeout`, because the adding is *how*
the fix was done, not what the branch is for. Needs `SENTRY_AUTH_TOKEN`; without it the
Shortcut `story_type: bug` path still works, just with no `△` link.

Cached in `~/.cache/termdash/branch-summaries.json`, keyed by full branch name, beside
`shortcut-summaries.json` and `sentry-summaries.json` — deliberately, so there is one
summarise-and-cache pattern in this repo rather than three. Not a dotfile inside the
worktree: that would sit in a shared repo's working tree and would be deleted by
`worktree clean` exactly when the row still needs it.

Generation is fire-and-forget off the poll loop, so a new worktree shows its raw name
for one round-trip and then settles. It's poll-driven rather than hooked into `worktree`
creation because worktrees also arrive via `git worktree add`, a teammate's script, or
Herdr's own new-worktree flow — a create-time hook sees none of those.

```sh
npx tsx cursor-status.ts --summarize           # fill what's missing, print evidence used
npx tsx cursor-status.ts --summarize --force   # re-do everything (run after a PR lands)
```

**A summary you disagree with is a text edit.** Entries are only ever written for keys
that are missing, so hand-editing `branch-summaries.json` sticks until you `--force`.
`TERMDASH_NO_LLM=1` turns the whole thing off — rows fall back to the fitted branch
name, still flicker-free.

**Cmd-click a branch name → that worktree's Space in Herdr.** The row tells you
the state; the click takes you to the work. `herdr-open.sh` joins the two on the
DIRECTORY PATH — `herdr worktree list` reports an `open_workspace_id` per
checkout, so an existing Space is focused (`herdr workspace focus`) and a missing
one is created (`herdr worktree open --path … --focus`). A click always lands
somewhere; it is never a no-op. Focusing a Space only changes what Herdr *draws*,
so the handler also raises the iTerm session the herdr client is running in —
otherwise the click looks like it did nothing from behind term-dash's own window.

Install the click target once (it owns the `herdr-space:` scheme — LaunchServices
dispatches schemes to bundles, never to scripts):

```sh
./build-herdr-open-app.sh
```

Without that app the link would be inert, so `cursor-status.ts` falls back to the
old **open-in-Cursor** behavior when `~/Applications/HerdrOpen.app` is missing:
`cursor://file/<path>?windowId=_blank`, whose `?windowId=_blank` forces a new
window instead of hijacking a sibling worktree's window into a branch switch.
Force either target with `TERMDASH_HERDR_LINKS=1` / `=0`.

**Close windows to save memory — click to bring them back.** Each open Cursor
window costs ~0.5–1 GB of RAM (renderer + extension host), while the worktrees
and their agents are cheap. So keep as many worktrees as you like and close the
windows you're not watching.

### The two non-obvious tricks

**1. Detecting "running" — the process, not the file.** The naive signal
("transcript file was modified recently") **is wrong.** An agent deep in a long
tool call — or working in a *subagent* — leaves its own transcript untouched for
minutes. So we read the OS process instead. Cursor keeps a live extension-host
per attached folder:

```
Cursor Helper (Plugin): extension-host (agent-exec) <worktree-basename> [n-m]
```

We combine **"is that process alive?"** (agent attached) with **the last record
in the transcript** (`turn_ended: success`/`error`, or turn still open) to
classify running / done / error. Process = attached, transcript = what happened.

**2. Detecting "waiting on you" — from Cursor's SQLite, not the transcript.**
When an agent calls its AskQuestion tool and blocks on your answer, that pending
question is **invisible in the jsonl transcript** — the last record is just the
previous completed step, so it looks identical to "running." The real signal is
Cursor's own state DB (`globalStorage/state.vscdb`): a latest tool call of
`ask_question` whose status is still `pending` = a live, unanswered question. We
overlay `‼ waiting` (yellow, matching Cursor's own flag) on top of a running
rollup when the DB confirms it.

Both signals are *100% local* — files, `git`, `ps`, SQLite, a URL scheme.
**No Cursor API key.**

### The rest of the layout

term-dash is this worktree panel plus a few sibling widgets, tiled by the
`termdash` bash launcher into a status strip over three columns:

```
┌──────────────────────────── local-status ────────────────────────────┐
├──────────────┬────────────────────────────┬──────────────────────────┤
│  worktrees   │                            │       git-notiql         │
│  + agents    │        plain shell         │                          │
│ (cursor-     │      (your terminal)       │                          │
│  status)     │                            ├──────────────────────────┤
├──────────────┤                            │       notion-todo        │
│    peers     │                            │                          │
└──────────────┴────────────────────────────┴──────────────────────────┘
   left, 15%            middle, 70%                  right, 15%
```

- **`git-notiql`** — GitHub PR radar: badges for replies on your own PRs, participating threads where you're waiting on a reply, and pending review requests. Also surfaces QA-app status on your own PRs from QA engineers' comments — 👷 while a "qa app deploy" environment is up, ✅ once "qa app destroy" signals it passed. (Cmd-click a badge → the comment.)
- **`local-status`** — the one-row strip across the top, spanning every column.
  Three justified segments:

  ```
  2:47 PM  Mon Aug 25  ◷ 18m Standup      KEYS ✗ CIRCLECI_TOKEN dead      CPU 23%  MEM 74%  SSH :2223 ✓  :3000 ruby 3.6G
  └────────────── left ──────────────┘      └──────── centered ───────┘      └───────────────── right ───────────────────┘
  ```

  The middle is the only segment that ever shouts. Clock, date, next meeting and machine
  vitals are fixed furniture you read *positionally* — always the same place, usually
  dim — so anything centered and red is by construction the thing that wants you.
  Centering rather than left-packing is what makes that work: the alert lands mid-screen
  no matter how wide the terminal is or how long the vitals happen to render. It reads as
  a ranked alert ticker: with no meeting imminent and nothing expiring or dead the center
  has nothing to say, so the only reason to look mid-strip is that something wants you. An empty middle is not taken as
  proof of health on its own — a missing cache shows a dim `KEYS ?`, and a `key-check`
  agent that stopped refreshing says so outright past `KEYCHECK_STALE_HOURS`.

  **The gap between the two ends is a wave.** Every blank cell between the clock block
  and the machine block carries the same braille animation `~/.zsh-sources/spinner.zsh`
  draws at the prompt — same maths, same colour stops, so it reads as the same object.
  It is a background, not a segment: its width is whatever the two ends leave over, and
  it reflows on its own as the vitals grow and shrink.

  **Alerts sit on top of it.** A terminal cell holds one glyph, so "behind the text"
  cannot mean the wave and the letter share a cell — it means the wave owns every cell
  the text does not. The alert keeps its own colour and gets a blank gutter each side,
  so it reads as sitting *on* the wave rather than tangled in it:

  ```
  10:17 AM  Fri Sep 4 ⠉⠢⣀⠤⠤⠒⠊⠑⢄⡠⠤⠔⠒⠉⠢⣀⠤⠤⠒⠊⠑⢄⡠⠤⠔ ◷ in 12m — The Marketeers Standup ⠤⠒⠒⠉⠢⣀⠤⠔⠒⠊⠑⢄⡠⠤⠒⠒⠉⠢⣀⠤ CPU 25%  MEM 62%
  ```

  Compositing is why the frame cache holds **one string per cell** rather than one per
  frame — a joined frame is a soup of colour escapes with no boundary you can safely cut
  on. A `RESET` goes in before the leading gutter or the last wave cell's colour bleeds
  into the blank and the alert looks like it has a coloured shadow; the trailing side
  needs none, since the next wave cell opens with its own escape.

  The alert is centred **on the line, not in the gap** — the overlay is handed the screen
  column the wave starts at and the full strip width, not just the cell array. Centring
  within the array is the obvious thing and it is wrong for exactly the reason
  `layoutStrip` spells out: the two ends are different lengths (a ~20-cell clock block
  against a ~50-cell machine block), so the gap's midpoint sits some 15 columns left of
  the line's and the alert visibly drifts. Verified against the old path — with room to
  move, `TERMDASH_IDLE_WAVE=0` and `=1` put the alert on identical columns. Where the
  alert nearly fills the gap both clamp instead, and the wave version lands within a
  column of the plain one.

  Widening genuinely adds wave rather than stretching it: the wavelength is pinned in
  *samples*, not scaled to the width, so 32 cells shows ~5 cycles and 105 shows ~16.
  One cell of air is held back at each end so the wave never abuts the clock or the CPU
  readout.

  This is not the thing that gets turned off in the widget panes, and the difference is
  what makes it safe. That spinner was a separate process painting over a pane it did
  not own, at the cursor, blind to what was underneath. This is part of a line this
  process already redraws in full every frame — there is nothing to smear onto. All 52
  frames (4 shapes × 13 phases) are precomputed per width, so the lane measures **0.00s
  of CPU per 10s** even repainting at 12.5fps all day; the shell painter cost ~0.06s per
  10s per pane recomputing `sin()` in shell arithmetic.

  The lane no longer stands down while an alert is up — with the wave as the background,
  stopping would freeze it around a live alert, which looks broken rather than calm.
  `TERMDASH_IDLE_WAVE=0` turns the whole thing off and restores the plain empty centre.
  See it in a still frame with `npx tsx local-status.ts --mock --idle`, or with an alert
  on it via `--mock --mins=12`.

  On the left, `◷ 18m Standup` is your next meeting — a countdown rather than a clock
  time, because there is already a clock two segments over and what you want off a
  glance is the gap. It is permanently dim, like the clock beside it. If the invite
  carries a Teams or Zoom link, cmd-click the segment to join. Titles are capped
  (32 columns wide, 16 when the terminal is tight) since real invites run long.

  From **fifteen** minutes before the start until five minutes after, the meeting is
  promoted to the center and vacates the left — it is an alert at that point, not
  furniture, and printing it twice would burn the columns the center needs:

  ```
  11:04 AM  Tue Aug 25       ◷ in 12m — Standup  ·  KEYS ✗4      CPU 42%  MEM 67%  SSH :2223 ✓
  ```

  Fifteen rather than five because five is enough time to notice a meeting and not
  enough to finish a thought, close a branch and walk to a room. It is also Outlook's
  own default reminder, so the strip and the desktop notification now fire together
  instead of the strip lagging ten minutes behind it.

  While the meeting is still ahead of you the center alert is **blue** — the terminal
  scheme's own blue (ANSI 4), the same one the `◂` dev marker uses in the worktrees
  panel. Outlook's literal `#0078D4` was tried first and read as a foreign object: a
  saturated 24-bit blue beside this palette's yellows and greens is louder than an
  upcoming meeting deserves. The basic colour is tuned to the same background
  everything else here was tuned against. It flips to orange the moment the start time
  passes: at that point it is not a warning about the future, it is a thing already
  happening without you.

  The grace side of that window is bounded deliberately. A meeting you are forty minutes
  into is a fact rather than an alert, and leaving it in the center would mask every key
  failure for the length of the meeting. Once the window closes, the left picks the
  meeting back up for its duration, so coverage is continuous.

  `KEYS ✗4` there is the compact form. Center sources are ranked — an imminent meeting
  outranks a key problem, since a key stays actionable all day and a meeting starting in
  two minutes is actionable for two minutes. The winner takes the space it needs; a
  lower-ranked alert then tries its full wording, falls back to its badge, and is dropped
  only if even that will not fit. It never appears truncated, because a half-cut alert
  reads as noise and can be misread as part of the one beside it. Check the handover with
  `npx tsx local-status.ts --mock --imminent`, or land on an arbitrary countdown with
  `--mock --mins=12` — the two canned mock values (18 and 2) sit either side of the
  window, so `--mins` is the only way to test the boundary itself.

  Getting the calendar there takes two one-time steps:

  ```
  ./build-nextmeeting.sh                  # compile the EventKit helper
  ./bin/nextmeeting --calendars           # confirm EventKit sees the account
  ```

  plus adding the M365 account under **System Settings → Internet Accounts**, calendars
  only. That indirection is forced: new Outlook (16.112+) still answers AppleScript for
  `calendar 1` but reports **zero** `calendar events`, so scripting Outlook directly is a
  dead end. Syncing into Calendar.app puts the events in the local EventKit store, which
  gets push-fresh data with no OAuth app registration and no token to rotate. Until the
  account is added the segment is simply absent. A refused permission prompt shows a dim
  `CAL ?` — the one calendar failure that never fixes itself, and otherwise
  indistinguishable from a genuinely empty day.

  Narrow terminals shed the least useful parts in order rather than dropping a whole
  side. Measured with `--mock`, the sequence is: the center truncates, then the `:3000`
  readout goes (the SSH cell never sheds — see below), then the meeting title shortens, then the date, and only in the last
  ditch does a whole segment disappear. `COLUMNS=90 npx tsx local-status.ts --mock`
  renders one frame at a forced width to check that. Meeting titles shorten by word
  rather than by column — six words normally, three when the strip is tight — because
  a column cut lands mid-word and reads as a rendering bug instead of an elision.

  On the right, that trailing figure is a rough RSS total for the dev server's **whole process
  tree**, not the `:3000` listener alone — it's what catches the memory blowout after
  a few branch swaps. Under a Procfile runner (popmenu's `bin/dev` is overmind) the
  listener is only Rails at ~0.7 GB, while **rspack** — the bundler, on its own port,
  and the thing that actually balloons — is a *sibling* process under the same
  supervisor. Totalling just the listener would report a reassuring 0.7 GB while
  rspack ate 4. Dim while healthy, then yellow / orange / red past `DEV_MEM_WARN_GB`
  / `DEV_MEM_HIGH_GB` / `DEV_MEM_HOT_GB`. Shows MB below a gigabyte (a bare `node`
  dev server reads `37M`). RSS counts pages shared between processes once per
  process, so read it as a trend, not an exact figure.

  `SWAP` sits next to `MEM` and **is absent whenever swap is empty**, which is the
  normal state — so on a typical day it costs no columns at all. That's deliberate:
  `MEM %` already answers "how full is memory", and a permanent `SWAP 0` would
  spend width to say "no". The question swap answers is different and rarer —
  whether that fullness has started costing *disk*. It's read from
  `sysctl vm.swapusage`, not derived from `vm_stat`, because the compressor pages
  that `MEM %` counts as used are RAM and not swap, and conflating the two is the
  exact confusion this cell exists to clear up. Never dim: any non-zero value is
  yellow, then orange / red past `SWAP_HIGH_GB` / `SWAP_HOT_GB`. Since an empty
  swap renders nothing, `--mock` forces a non-zero value so the path is visible.

  `SSH :2223` is the one cell that is actionable rather than informative. It's the
  sshd the personal laptop connects in on, and its failure mode is asymmetric: you
  find out it's down at the exact moment you're away from the machine and can no
  longer start it. So it holds a permanent slot and never sheds on a narrow
  terminal — you can confirm `:3000` by glancing at a browser, and there is no
  equivalent glance for 2223. Dim `✓` when the door is open, red `✗` when it isn't,
  and **only the red one is clickable**: cmd-click runs `bin/ssh-2223-up.sh` behind
  the macOS admin prompt, which starts sshd *and* installs the LaunchDaemon that
  brings it back at every boot. Clicking a healthy cell would raise a password
  prompt to accomplish nothing, so it carries no link.

  ```
  ./build-ssh-app.sh      # one-time: build the cmd-click target
  ```

  That build step is not optional decoration. An OSC-8 hyperlink carries a URI, and
  LaunchServices will *launch an app* but only ever *open* a `.sh` in an editor — so
  the click target has to be an app bundle. It's a thin AppleScript shim that calls
  the script `with administrator privileges`; nothing here holds standing root, and
  there's no sudoers entry to audit. Until you run it the cell renders unlinked
  rather than offering a click that goes nowhere.

  Liveness is read from `netstat`, not `lsof`, and that is load-bearing rather than
  stylistic. `lsof` run unprivileged cannot see sockets owned by other users, and
  sshd is root — so an `lsof` probe reports 2223 **closed for the entire time SSH is
  working perfectly**. `netstat` reads the kernel socket table and has no such blind
  spot. It can't name the owning process, which costs nothing here: "is the door
  open" is the whole question.
- **`shortcut-peers`** — what the rest of the team is on, under the worktrees. One
  block per developer: a name line, then up to two ticket rows. Polls Shortcut
  every 5 minutes.

  ```
  Tonia Saba +1
   ⎿ sc-175442  atlas alert layouts
   ⎿ sc-175445  sms scheduling guard
  Jose Medeiros
   ⎿ sc-175457  mobile calendar preview
  ```

  The 2-3 word summaries are the point. Shortcut titles are written to be
  unambiguous in a backlog, not legible in 55 columns — "Do not create SMS
  campaigns scheduled in the past (Atlas import)" spends thirty characters before
  it says anything, and a column cut lands mid-clause and reads as a rendering
  bug. So each title is compressed **once** by `claude -p` and cached on disk
  forever, keyed on story id + title so a retitled ticket re-summarises and
  nothing else ever costs a second call. Steady state is zero LLM calls per poll.
  Same mechanism as the Sentry summaries in `morning-brief.ts`, on purpose — one
  summarise-and-cache pattern in this repo, not two. Falls back to the truncated
  title if `claude` is missing or slow; `TERMDASH_NO_LLM=1` disables it.

  **The pane resizes itself.** tmux can't do this for you — its hooks are all
  command and lifecycle events (`after-<command>`, `client-resized`, `pane-died`),
  there is no content-changed event, and a layout is geometry that knows nothing
  about how many rows a program printed. So the pane asks: it counts the rows it
  is about to draw and calls `tmux resize-pane -t "$TMUX_PANE" -y N`, and tmux
  hands the slack to the worktrees panel above. Peers shrinking *is* worktrees
  growing, which is why only this pane self-sizes — two panes in one column both
  doing it would fight over every row, and the worktrees panel needs no resize
  logic at all.

  `LEFT_BOTTOM_HEIGHT` in `termdash` is therefore only a starting value.
  `PEERS_MAX_ROWS` is the real constraint: `resize-pane -y` is bounded by the
  *window*, not by anything reasonable for the neighbour — ask for 40 rows in a
  30-row window and the sibling lands at `h=1` — so that cap is what reserves a
  floor for worktrees. It only re-sizes when the number actually changes, so it
  won't stomp a manual drag every five minutes. `TERMDASH_NO_AUTOSIZE=1` turns it
  off.

  One consequence worth knowing: the frame is written in a **single** write with
  **no trailing newline**. Printing N lines into an N-row pane scrolls the first
  line off the top — the same trap `local-status.ts` documents for its 1-row
  strip, and it bites much harder here now that the pane is sized to fit exactly.

  A ticket owned by two people renders under **both**. That isn't a dedupe bug —
  the pane answers "what is this person on", and a shared ticket is on both plates.
  Overflow past two rides as a `+N` on the name line rather than taking a row of
  its own, and a peer with nothing active is omitted entirely.

  **`PEERS` is a hand-maintained constant, and identifying developers is subtler
  than it looks.** The obvious rule — "owns stories with branches or PRs attached"
  — is wrong, because it measures the *ticket*, not the person: QA are assigned as
  owner during the QA phase, by which point the developer's PR is long since
  attached. On this team it ranked the QA lead first, with 45 of her 48 stories
  carrying code. The rule that works keys on **who authored the branch**, since
  Popmenu branches are `<mention_name>/sc-<id>/<slug>`. `npx tsx
  shortcut-peers.ts --classify` applies it and prints a paste-able `PEERS` line.

  That runs on demand rather than per poll: branches are absent from the search
  payload, so it costs a detail request per story, and its failure mode is silent
  — a developer who didn't push inside the sample window just vanishes from the
  pane, indistinguishable from having nothing on. A stale constant fails visibly,
  and the roster changes about twice a year.

- **`notion-todo`** — this week's list, live. Reads the most recent `M/D` heading
  on the page and renders its to-dos: **click a row to check it off** (it stays
  put, drawn dim + struck-through), **wheel / ↑↓ / PgUp-PgDn** to scroll, and the
  input line at the bottom appends a new item under the same heading. Writes go
  straight to Notion; the pane re-reads every 45s so edits made in Notion itself
  show up here (Ctrl+R forces it, Ctrl+U clears the input line). Clicking needs
  tmux `set -g mouse on` — the pane asks for mouse reporting, tmux forwards it.
- **middle panes** — plain shells for actual work.

Every widget is the same shape: small, self-refreshing, colored, OSC-8 clickable
links (iTerm2). Swap what runs where in the `CONFIG` block of `termdash`.

### The morning brief (`morning-brief.ts`) — the one part that isn't a pane

Every widget above answers "what is true right now" and repaints forever. The
morning brief answers a different question — **what changed while I was gone** —
and that difference is why it's a **tmux popup** (`display-popup`, 3.2+) rather
than a fifth pane. A pane would cost permanent screen area to show something
stale by 9am; a popup floats over the layout, takes no space from it, and is
gone on `q`.

Three sections, all scoped to a window that runs from **3pm the previous weekday**
to now (Monday's brief reaches back to Friday, so the weekend isn't a hole):

- **AGENDA** — today's calendar as a timeline, with the *gaps* drawn in. "Four
  meetings" and "four meetings, all before 1pm" are different days. Comes from
  `bin/nextmeeting --agenda`, the same EventKit binary the status strip uses.
- **REVIEWS** — the 🤝 category from `git-notiql.ts` (your team's Shortcut
  "Ready for Review" *or* "In Development" columns), narrowed to PRs that went up
  *inside* the window. Both columns, because the column is a human ritual and the
  PR is not — people open a PR and forget to drag the ticket, and that PR is then
  invisible to a query keyed on the column alone.

  "Already reviewed" is decided on **GitHub**, not on Shortcut's `review_status`.
  Popmenu/popmenu requires two approvals and Shortcut flips to `approved` after
  the *first*, so it reports "somebody approved this" rather than "this is done
  being reviewed" — which silently hid PRs that were still waiting on a second
  reviewer. `reviewDecision` is the branch-protection verdict itself, so required
  reviewers, CODEOWNERS and dismissed-stale-review rules all come along for free.
  Ones you've already approved are dropped; ones you've commented on are marked
  `✎`. A PR that's been waiting since Tuesday is already in the git-notiql pane
  all day — repeating it here would make the brief a second copy of a panel you
  already have, so it's reduced to a one-line count.
- **SENTRY** — the team's **own** queue: `assigned:#marketeers` inside the two
  projects it owns (`popmenu-web-rails`, `popmenu-web-react`). An issue nobody on
  the team owns never appears.

  It's **one ranked list, not four thresholded categories**, and that's a
  deliberate correction. The section originally ran four independent rules —
  new / regressed / spiking / high-reach — with thresholds calibrated against
  org-wide traffic (≥50 events, ≥250 users). Under team scoping the entire pool
  is ~14 issues topping out at **18 events and 2 users** in 24h, so two of those
  four rules *could never fire*. They were dead code that read like coverage.

  So: fetch the queue once, rank it, tag each row with the most alarming true
  thing about it. Nothing the team owns can fall through, because there's no
  threshold left to fall through.

    | Tag | Meaning |
    |---|---|
    | `REGRESS` | Sentry says this came back after being fixed |
    | `NEW` | first seen inside the 7-day window |
    | `SPIKE` | ≥8 events **and** ≥3× its 13-day median |
    | `·` | in the queue, firing, neither new nor climbing sharply |

  A **`⛔n`** marker on the row counts how many of those 24h events **exhausted
  their Sidekiq retries** — that job is not coming back and whatever it was going to do didn't
  happen. It ranks above `NEW` and `SPIKE` (below `REGRESS`) because it's the only
  tier here that is confirmed damage rather than a symptom.

  A **`→team?`** hint marks a row whose *code* looks like another team's product
  area (`Sidekiq/CustomPage::PublishDrafts` → `the-a-team`, Web Builder). It is
  **advice only** — the brief never calls Sentry's assignment API. Run the
  `sentry-assignment` skill to check one properly, then reassign by hand.

  > The obvious implementation — regex the ownership doc's product areas — was
  > measured and is **worse than nothing**. Both of its hits on the real queue
  > were wrong: `SocialPost::LivePost::SnapshotAll` matched *"snapshot"* → Phoenix
  > (Weekly Snapshot Email) when it's Social Posting, and
  > `OpenTableSync::ReservationsSync` matched *"reservation"* → Phoenix when
  > OpenTable Integration is explicitly Marketeers. Generic English in the doc —
  > reservation, snapshot, review, cart, segment, feedback — collides with
  > ordinary code vocabulary. The shipped table is vendor and Ruby-namespace
  > tokens only, matched against the **culprit**, and deliberately omits the
  > genuinely ambiguous areas (SMS, DoorDash, Offers, Menu/Order Management)
  > because only a stack trace settles those. Result: 3 hints across 69 issues,
  > no false positives.

  > Getting that number took three tries. `/issues/{id}/tags/{key}/` **ignores
  > `statsPeriod`** and reports lifetime counts; adding `sidekiq_final_retry:True`
  > to the issue search returns the issue's **full** event count, not the tagged
  > subset. Both would have said 18 where the answer is 3. Only the `events`
  > dataset aggregates per issue — and it does the whole pool in one request,
  > pinned to explicit issue ids so a page limit can't silently drop one.
  >
  > Also: the tag value is Ruby-cased `"True"`. `sidekiq_final_retry:true` is a
  > perfectly valid query that matches **nothing**.

  Row text is a **cached one-line summary**, not the Sentry title. A title like
  `ActiveRecord::QueryCanceled: PG::QueryCanceled: ERROR: canceling statement due
  to statement timeout` spends 60 characters saying "a query timed out" and is
  then truncated before it says *where*; the summary says
  `Campaign enqueuer timing out`. Generated once per issue by `claude -p`, cached
  in `~/.cache/termdash/sentry-summaries.json`, keyed on title+culprit so a
  changed error re-summarises and an unchanged one never costs a second call.
  Steady state is **zero LLM calls** — measured 11.8s cold, 4.3s warm. Falls back
  to the raw title if `claude` is missing, unauthenticated or slow; set
  `TERMDASH_NO_LLM=1` to skip it entirely.

  Every row carries **direction** rather than raw volume — `↑1.5× vs 12/day`,
  `steady ~3/day`, `↓0.4× vs 8/day`, `first in 13d`. On a bug you're working, the
  question isn't how loud it is, it's whether the fix is landing.

  Two details that took real debugging:

  > **`firstSeen` is a trap.** The `firstSeen` *field* on a returned issue is
  > window-relative (clamped to `statsPeriod`); the `firstSeen:` *query filter*
  > uses the true lifetime. At `statsPeriod=24h`, issues first seen in **June**
  > report `firstSeen` as yesterday. Trust the query filter; never read the field.

  > **Sentry titles are not unique.** The two `OpenTable::Sync::UnhandledError`
  > issues have byte-identical titles — only `culprit` distinguishes them
  > (`GuestsSync` vs `ReservationsSync`). Rows append the culprit *only* where a
  > title repeats, since paying that width everywhere would cost title text to
  > solve a problem most rows don't have.

**Generation and display are separate events**, on purpose:

| When | What |
|---|---|
| 06:00 | launchd fires `morning-brief.ts --write` and caches the day's brief. All the slow work happens here, off the critical path. Uses `StartCalendarInterval`, not cron, so a Mac that was asleep at 6am runs it on wake instead of missing it. |
| first arrival | `client-attached` **and** `client-focus-in` hooks pop the cached brief the first time you show up that day. Popping it at 06:00 sharp shows it to an empty chair — or to a chair you sat down in at 06:20, having already dismissed it with a stray keypress. Two hooks because `client-attached` alone misses the common case: the Mac sleeps or locks with the dashboard still attached, so unlocking it at 8am is not an attach and nothing fires. `client-focus-in` catches the keyboard coming back — unlock, cmd-tab, tab switch. Both call the same `brief-if-unseen`, which short-circuits on the day's `.seen` marker, so they can't double-pop. A locked screen can't hold focus, which is why this is a hook rather than a polling timer: the popup can never open to nobody and burn the day's brief. Needs `focus-events on` (set by `termdash up`), and tmux only requests focus reporting at attach time — so a running dashboard must `termdash restart` to pick it up. |
| `prefix`+`b` | re-opens it any time. This is what makes "ephemeral" safe: dismissing it is never destructive. |

Install the schedule once:

```sh
ln -sf "$PWD/com.colinsteele.morning-brief.plist" ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.colinsteele.morning-brief.plist
```

The hook and keybinding are installed by `termdash up`, so an already-running
session needs a `termdash restart` (or one manual `tmux set-hook`) to pick them up.

#### The Chrome page (replacing the popup)

Every build of the brief (`--write`, `--fresh`, `--cached`, `--html`) also writes
a self-contained page to `~/.cache/termdash/brief/today.html` (dated copies sit
beside it). It's a to-do list rather than a delta: the things waiting on you come
first, the agenda is a sidebar, and every row is a link.

| Section | What's in it |
|---|---|
| Reviews you owe | the REVIEWS section above |
| Your PRs | your open PRs, in order of whose move it is: `CI RED` → `CHANGES` → `CONFLICT` → `MERGE IT`; ones waiting on reviewers and drafts are folded away |
| Talking to you in Shortcut | comments since the window opened that @-mention you or sit on a story you own |
| Sentry | the SENTRY section above, with the folded-away groups as one line each |
| New on the Marketeers board | team stories created since the window opened that you don't own; missing estimates and owners shown in red |
| Your stories | started and blocked stories; the rest folded away |

Shortcut has no notifications API, and its search silently ignores `comment:`
and `mention:`, so "talking to you" is worked out by reading the comments on
team stories and your own stories. A mention on another team's story that you
don't own is **not** caught.

`brief-open` puts the page in front of you: it finds a Chrome tab already
showing it (or opens one), reloads it, raises that window, centers it on the
primary display and activates Chrome. It finds the tab itself because tabjump
ignores `file://` URLs. It reaches Chrome **by process ID**, picking the one Chrome
process with no `--user-data-dir`. Playwright launches signed-out copies of
the same app, and `tell application "Google Chrome"` would pick any of them. `bin/unlock-watch`
runs it on each screen unlock. With `--if-unseen` it only acts once a day (every
day, weekends included), after 06:00, and builds the brief first if the 06:00 job hasn't run.

```sh
./build-unlock-watch.sh
./brief-open        # once by hand, to answer macOS's "control Google Chrome?" prompt
ln -sf "$PWD/com.colinsteele.brief-unlock.plist" ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.colinsteele.brief-unlock.plist
```

Expect a second Automation prompt, naming unlock-watch, the first time it fires
on its own. The log is `~/.cache/termdash/brief-unlock.log`. To remove it, run
`launchctl bootout gui/$UID/com.colinsteele.brief-unlock`.

> **`git-notiql2.ts`** is an alternate build of the PR widget that adds a
> Shortcut-driven "NEEDS REVIEW" category (open team PRs you haven't reviewed).
> It's not wired into the default layout — point `RIGHT_TOP_CMD` at it in
> `termdash` to use it instead. It needs `SHORTCUT_RO_TOKEN` plus the `TEAM_NAME`
> / `TEAM_REPOS` constants set in the file; see its header for setup.

### Takeaways

1. **Worktrees turn parallel tasks into folders** — cheap to spin up, easy to lose track of.
2. **term-dash joins everything on the folder path** — git + CI + agent state + click-to-open, one row per task.
3. **Two signals earn their keep** — "running" is process-based (not file-mtime); "waiting on you" comes from Cursor's SQLite (not the transcript).
4. **Windows are the memory cost, not worktrees** — close idle ones (~0.5–1 GB each); one click reopens the exact worktree and restores its agent chat.
5. **100% local, no Cursor API** — it reads files and processes you already have.

</details>

<details>
<summary><h2>The <code>worktree</code> command</h2></summary>

term-dash *observes* worktrees; [`worktree.zsh`](./worktree.zsh) is the companion
that **creates and tears them down** — turning the raw `git worktree add`
dance from the intro into one command that also provisions the new checkout and
opens it in Cursor. It's plain zsh (relies on zsh-only features — don't run it
with bash).

### Install

It *defines* functions, so source it from your `~/.zshrc` (it doesn't run on its
own), then `source ~/.zshrc`:

```sh
source ~/Code/term-dash/worktree.zsh
```

Dependencies: `git` (required); `gh` (for `worktree clean`; optional for `rm`);
the `cursor` CLI and `bundle`/`yarn` (optional — used only if present).

### Commands

| Command | What it does |
|---|---|
| `worktree -b <branch>` | Create a **new** branch off origin's default branch (`master` for popmenu), in a sibling `<repo>-worktrees/<last-segment>` dir, provision it, `cd` in, and open it in a new Cursor window. Fetches first and **aborts if the fetch fails** rather than silently forking off a stale base; prints the base branch and commit it used. |
| `worktree <branch>` | Same, for an **existing** (local or remote) branch. |
| `worktree rm` | Remove the worktree you're **standing in** — merged or not (type `delete` to confirm). Moves your shell back to the main checkout. |
| `worktree clean [-y]` | Remove **all** worktrees whose GitHub PR has merged (uses `gh`, so squash-merges count). Skips dirty ones; `-y` skips the prompt. |

`termdash` itself takes `up` / `down` / `restart` / `status`, plus:

| Command | What it does |
|---|---|
| `termdash brief` | Pop today's morning brief over the layout (same as `prefix`+`b`). Prints to stdout instead if the dashboard isn't running. |
| `termdash brief-now` | Regenerate and print the brief, ignoring today's cache — what you want after changing a threshold. |
| `./morning-brief.ts --json` | Raw gathered data, no rendering. For debugging a section that looks wrong without re-reading ANSI soup. |

Worktrees are created as a **sibling** dir (`popmenu` → `popmenu-worktrees/foo`),
never nested inside the main checkout — a nested path confuses Cursor about which
window owns a file, so diff/file links open in the wrong window.

### What creation provisions

A fresh worktree is missing everything gitignored, so `worktree -b` copies/links
it in. All steps are guarded by existence checks — **they no-op outside the
popmenu repo**:

- symlinks `.husky/_` back to the main checkout (so the pre-commit hook works);
- copies the gitignored `.env` / `.env.*` and `.bundle/config` over;
- `nvm use`s the node version the repo pins — `.nvmrc`, `.node-version`, or
  `.tool-versions` (popmenu: `24.14.0`), read from the worktree and falling back to
  the main checkout, and `nvm install`ed if it's missing. This happens **before**
  the installs, since `yarn install` builds native modules against the active node;
  it also sticks in your shell after the `cd`. Needs nvm loaded in your shell (it's
  a shell function, not a binary) — no nvm or no version file, and it's a no-op;
- runs `bundle install` / `yarn install` if a `Gemfile` / `package.json` is present (non-fatal);
- symlinks each `docs/plans/*` entry from the main checkout.

### Teardown rolls back the shared dev DB (popmenu)

Every worktree copies the same `.env`, so they all point at **one shared Postgres
dev DB**. A migration you ran on a branch stays applied there after you leave it,
and the next worktree's `db:*` tasks then re-annotate `app/models/**` +
re-dump `db/schema.rb` against that drifted DB — the endless "salesforce models
changed" noise. So `worktree rm` runs `rake migrate_branch_down` first (when the
task exists), rolling back **only that branch's** migrations so the DB returns to
master state and the next worktree opens clean. It's best-effort: a failed
rollback warns but still removes the tree. `worktree clean` deliberately does
*not* do this — merged branches' migrations belong to master and must stay
applied.

</details>

<details>
<summary><h2>Setup</h2></summary>

This gets a new team member from a fresh clone to a running dashboard. The
widgets read all secrets from **environment variables** — there is no `.env`
loader. Export them in your shell profile (`~/.zshrc`) so they're present in
every tmux pane.

### 1. Prerequisites

| Tool | Why | Install (macOS) |
|------|-----|-----------------|
| `tmux` | owns the pane layout | `brew install tmux` |
| `node` (18+) | runs the widgets | `brew install node` |
| `npx tsx` | executes the `.ts` widgets directly | comes with node; first run auto-installs `tsx` |
| `gh` (authed) | `cursor-status.ts` reads PR/merged state via `gh`; also drives `worktree clean` | `brew install gh && gh auth login` |
| iTerm2 | the widgets emit iTerm2-flavored OSC 8 clickable links | `brew install --cask iterm2` |

Built and tested on macOS with iTerm2. Clickable links and `cursor://` /
`herdr-space://` / Activity Monitor deep-links assume iTerm2. `herdr-space://`
additionally needs Herdr on `~/.local/bin/herdr` and one run of
`./build-herdr-open-app.sh`.

### 2. Clone

```sh
git clone <your-org>/term-dash.git ~/Code/term-dash
cd ~/Code/term-dash
```

### 3. Alias the launcher

Add to `~/.zshrc` (adjust the path to where you cloned), then `source ~/.zshrc`:

```sh
alias termdash="$HOME/Code/term-dash/termdash"
```

### 4. API tokens

Export each of these in `~/.zshrc`. Which you need depends on which widgets you
keep — a widget with a missing token prints an error in its own pane but doesn't
break the rest of the dashboard.

```sh
# ~/.zshrc
export GITHUB_TOKEN="ghp_..."          # git-notiql
export CIRCLE_CI_TOKEN="..."           # cursor-status (the ● CI dots in the worktrees panel)
export NOTION_TOKEN="ntn_..."          # notion-todo
export NOTION_PAGE_ID="..."            # notion-todo (page to append to; 32-char id from its URL)
export SHORTCUT_RO_TOKEN="..."         # git-notiql (🤝 category), morning-brief (REVIEWS)
export SENTRY_AUTH_TOKEN="sntrys_..."  # morning-brief (SENTRY) — org:read + project:read + event:read

# Optional: reuse Chrome tabs instead of opening a new one per click.
# Needs the handler app from tab-reuse.md — inert without it, so leave unset
# until you've installed it.
export TERMDASH_REUSE_TABS=1
```

After editing, `source ~/.zshrc` (or `termdash restart` from a fresh shell) so
the panes inherit the new values.

#### Where to get each token

| Env var | Used by | Where to get it | Scope needed |
|---------|---------|-----------------|--------------|
| `GITHUB_TOKEN` | `git-notiql.ts` | GitHub → Settings → Developer settings → **Personal access tokens**. Classic is simplest. | `repo` (read private repos) + `read:user`. Authorize SSO for your org if it enforces SAML. |
| `CIRCLE_CI_TOKEN` | `cursor-status.ts`, `herdr-sync.ts` | CircleCI → **User settings → Personal API Tokens**: <https://app.circleci.com/settings/user/tokens> | Personal API token (read is enough). `CIRCLECI_TOKEN` is read as a fallback if `CIRCLE_CI_TOKEN` is unset. |
| `NOTION_TOKEN` | `notion-todo.ts` | Notion → <https://www.notion.so/my-integrations> → **New integration** (internal). Copy the secret. Then **share the target page with the integration** (page → ••• → Connections), or it can't write. | Insert content on the shared page. |

`local-status.ts` needs **no tokens**. `cursor-status.ts` needs `CIRCLE_CI_TOKEN`
(for the ● CI dots) and an **authed `gh`** (for the ⎇/↥ PR + merged glyphs);
everything else it reads — git worktrees, processes, Cursor's own files — is local.

### 5. Per-user config to change

A few values are hardcoded to the original author's setup. Check/adjust these in
your clone:

| File | Setting | Current value | Change to |
|------|---------|---------------|-----------|
| `cursor-status.ts` | `REPOS` | dir→CircleCI-slug map incl. `gh/Popmenu/popmenu` | Your worktree repo dirs + their CircleCI slugs (`gh/<org>/<repo>`); use `null` for repos not on CircleCI. |
| `cursor-status.ts` | `SC_SLUG` | `"popmenu"` | Your Shortcut workspace slug — drives the ◆ story links off `sc-<id>` branches. |
| `cursor-status.ts` | `DEV_PORT` | `3000` | Port your dev server listens on — drives the ◂ "serving here" marker. |
| `cursor-status.ts` | `HUBDIFF_BASE` | `hubdiff://` | URL base of your local diff viewer — drives the ± links. A custom scheme (native app) or an `http://…` base both work; the ± link bypasses `webLink`, so an http base opens a plain tab. Drop the `diff` glyph from `render()` if you don't run a viewer. |
| `termdash` | `STATUS_HEIGHT` | `1` | Rows given to the top strip. `local-status` writes exactly one line with no trailing newline, so anything taller is dead space. |
| `local-status.ts` | `PORT_TO_WATCH` | `3000` | Port your dev server listens on — drives the `:3000 <proc>` readout and its memory total. |
| `local-status.ts` | `DEV_MEM_WARN_GB` / `DEV_MEM_HIGH_GB` / `DEV_MEM_HOT_GB` | `6` / `7` / `8` | Yellow / orange / red thresholds for the dev-stack memory total. **Whole-tree** totals — set them above your own idle baseline or every reading looks like a warning (popmenu idles ~3.5–4 GB). |
| `local-status.ts` | `DEV_SUPERVISOR_RE` | `overmind\|foreman\|hivemind\|Procfile\|bin/dev` | How far up the process tree to climb from the port's listener before totalling. Add your Procfile runner if it isn't one of these; the memory figure will otherwise cover only the listener and its own children. |

> `notion-todo.ts`'s target page is **not** hardcoded — set the `NOTION_PAGE_ID`
> env var (step 4) to the Notion page **you** want to-dos appended to. That page
> is expected to be organised as weekly headings whose text starts with `M/D`
> (`8/24`); the pane shows the **last** such heading's to-dos and appends there.

> `git-notiql` derives **your** GitHub username automatically from `GITHUB_TOKEN`
> (via `/user`) — there's no username to set.

### 6. Run it

```sh
termdash up        # start (or attach if already running)
termdash status    # show what's running in each pane
termdash restart   # down, then up  (use after changing tokens/config)
termdash down      # kill the session
```

Layout, pane sizes, and which widget runs where live in the `CONFIG` block near
the top of the [`termdash`](./termdash) launcher.

### 7. Troubleshooting

- **A pane shows a token error** — that env var isn't visible in the pane.
  Confirm it's exported (`echo $GITHUB_TOKEN`), then `termdash restart`. tmux
  panes only inherit env vars present when the session starts.
- **GitHub 401/404 on private repos** — token needs `repo` scope and, for SAML
  orgs, SSO authorization (token page → "Configure SSO" → authorize).
- **Notion write fails** — the integration hasn't been shared with the target
  page, or `NOTION_PAGE_ID` points at a page you don't own.
- **Worktrees panel shows gray dots / no PR glyph** — no CircleCI token (CI dots)
  or `gh` not authenticated (`gh auth status`) for the PR/merged glyphs.
- **Gray dots even though a CircleCI token *is* set** — the token is set but
  rejected, which looks identical to no token at all: the "no token" warning
  checks only that the var is non-empty, so a revoked key fails silently. Test the
  key itself rather than its presence:
  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' -H "Circle-Token: $CIRCLE_CI_TOKEN" \
    https://circleci.com/api/v2/me      # 200 = live, 401 = revoked
  ```
  Both `CIRCLE_CI_TOKEN` and `CIRCLECI_TOKEN` are read, in that order — if you have
  both defined, check the one that actually wins.
- **Emoji/links render oddly** — the widgets target iTerm2; other terminals may
  mangle OSC 8 links and wide glyphs.

</details>
