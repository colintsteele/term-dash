# term-dash

A glanceable terminal dashboard for a **worktree-per-task** development flow.
One command (`termdash up`) tiles small, self-refreshing TypeScript widgets into
a 3-column tmux layout so the state of everything you have in flight — branches,
CI, AI agents, PRs — sits in one place.

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
| `cursor://file/<path>` | the abs path | click to jump into that window |

So a **single row** in the worktrees panel fuses git + CI + agent state, and
clicking it drops you straight into that Cursor window. That fusion is the whole
point.

### What you see (the Worktrees panel — `cursor-status.ts`)

```
WORKTREES + AGENTS                         (updated 3:14 PM, every 30s)
────────────────────────────────────────────────────────────────────
 ● ✗ popship    sc-162243/flaky-test-service   2m
 ● ‼ popmenu    sc-170267/list-cleanup         now
 ● ▸ popmenu    sc-171002/campaign-builder     now
 ● ✓ popmenu    master                         14m
 ● ✓ term-dash  main                           1h
────────────────────────────────────────────────────────────────────
 2 done   1 run   1 attn   1 err
```

Reading one row, left to right:
- **`●` colored dot** — CI status for that branch: red failed · yellow running · green passed · gray unknown (cmd-click → the CircleCI workflow).
- **repo · branch** — from `git worktree list`. Cmd-click the name → opens/focuses that worktree's Cursor window (see below).
- **agent glyph** — `▸ running · ✓ done · ‼ waiting on you · ✗ error · · none`.
- **age** — how long since the agent's last activity.

Triage in one glance: `‼` and `✗` are where you go; `▸` is working, leave it.

**Close windows to save memory — click to bring them back.** Each open Cursor
window costs ~0.5–1 GB of RAM (renderer + extension host), while the worktrees
and their agents are cheap. So keep as many worktrees as you like and close the
windows you're not watching. Cmd-clicking a row opens a **fresh window on that
exact worktree** — the link uses `cursor://file/<path>?windowId=_blank`, which
forces a new window instead of hijacking a sibling worktree's window into a
branch switch. Cursor even restores that worktree's saved agent chat on reopen.

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
`termdash` bash launcher into a 3-column tmux layout:

```
┌──────────────┬────────────────────────────┬──────────────┐
│ local-status │                            │  git-notiql  │
├──────────────┤      fat terminal          ├──────────────┤
│              │      (plain shell)         │  cursor-     │
│  worktrees   │                            │  status      │
│  + agents    ├────────────────────────────┤  (worktrees) │
│              │   mini terminal (shell)    ├──────────────┤
│              │                            │ notion-todo  │
└──────────────┴────────────────────────────┴──────────────┘
   left, 15%            middle, 70%              right, 15%
```

- **`git-notiql`** — GitHub PR radar: replies on your PRs, threads you're in, review requests, team PRs needing review.
- **`local-status`** — CPU / memory / what's on port 3000.
- **`notion-todo`** — type a to-do, Enter, it lands under this week's toggle in Notion.
- **middle panes** — plain shells for actual work.

Every widget is the same shape: small, self-refreshing, colored, OSC-8 clickable
links (iTerm2). Swap what runs where in the `CONFIG` block of `termdash`.

### Takeaways

1. **Worktrees turn parallel tasks into folders** — cheap to spin up, easy to lose track of.
2. **term-dash joins everything on the folder path** — git + CI + agent state + click-to-open, one row per task.
3. **Two signals earn their keep** — "running" is process-based (not file-mtime); "waiting on you" comes from Cursor's SQLite (not the transcript).
4. **Windows are the memory cost, not worktrees** — close idle ones (~0.5–1 GB each); one click reopens the exact worktree and restores its agent chat.
5. **100% local, no Cursor API** — it reads files and processes you already have.

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
| iTerm2 | the widgets emit iTerm2-flavored OSC 8 clickable links | `brew install --cask iterm2` |

Built and tested on macOS with iTerm2. Clickable links and `cursor://` /
Activity Monitor deep-links assume iTerm2.

### 2. Clone

```sh
git clone <your-org>/term-dash.git ~/Code/term-dash
cd ~/Code/term-dash
```

> `Claude.dmg` (a ~330 MB binary) is currently checked in at the repo root and
> is unrelated to the dashboard. Consider removing it / `.gitignore`-ing it
> before publishing to save everyone the download.

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
export GITHUB_TOKEN="ghp_..."          # git-notiql, circleci-status
export CIRCLECI_TOKEN="..."            # circleci-status
export NOTION_TOKEN="ntn_..."          # notion-todo
export SHORTCUT_RO_TOKEN="..."         # git-notiql2 (NEEDS REVIEW category only)
```

After editing, `source ~/.zshrc` (or `termdash restart` from a fresh shell) so
the panes inherit the new values.

#### Where to get each token

| Env var | Used by | Where to get it | Scope needed |
|---------|---------|-----------------|--------------|
| `GITHUB_TOKEN` | `git-notiql.ts`, `git-notiql2.ts`, `circleci-status.ts` | GitHub → Settings → Developer settings → **Personal access tokens**. Classic is simplest. | `repo` (read private repos) + `read:user`. Authorize SSO for your org if it enforces SAML. |
| `CIRCLECI_TOKEN` | `circleci-status.ts` | CircleCI → **User settings → Personal API Tokens**: <https://app.circleci.com/settings/user/tokens> | Personal API token (read is enough). |
| `NOTION_TOKEN` | `notion-todo.ts` | Notion → <https://www.notion.so/my-integrations> → **New integration** (internal). Copy the secret. Then **share the target page with the integration** (page → ••• → Connections), or it can't write. | Insert content on the shared page. |
| `SHORTCUT_RO_TOKEN` | `git-notiql2.ts` | Shortcut → **Settings → API Tokens**: <https://app.shortcut.com/settings/account/api-tokens> | Read-only — only looks up which team owns a story. |

`local-status.ts` and `cursor-status.ts` need **no tokens** — fully local.

### 5. Per-user config to change

A few values are hardcoded to the original author's setup. Check/adjust these in
your clone:

| File | Setting | Current value | Change to |
|------|---------|---------------|-----------|
| `circleci-status.ts` | `PROJECT_SLUGS` | `["gh/Popmenu/popmenu"]` | Your CircleCI project slug(s), form `gh/<org>/<repo>`. |
| `git-notiql2.ts` | `TEAM_REPOS` | `["Popmenu/popmenu"]` | Repo(s) to scan for team PRs needing review. |
| `git-notiql2.ts` | `TEAM_NAME` | `"Marketeers"` | Your exact Shortcut team name. |
| `notion-todo.ts` | `PAGE_ID` | `2df7e368-…` | The Notion page **you** want to-dos appended to (from its URL). |

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
  page, or `PAGE_ID` points at a page you don't own.
- **`NEEDS REVIEW` empty in git-notiql2** — `SHORTCUT_RO_TOKEN` unset or
  `TEAM_NAME` doesn't match your Shortcut team's exact name.
- **Emoji/links render oddly** — the widgets target iTerm2; other terminals may
  mangle OSC 8 links and wide glyphs.

</details>
