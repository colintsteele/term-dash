# term-dash

A glanceable terminal dashboard for a **worktree-per-task** development flow.
One command (`termdash up`) tiles small, self-refreshing TypeScript widgets into
a 3-column tmux layout so the state of everything you have in flight — branches,
CI, AI agents, PRs — sits in one place.

Below the monitor <img width="5712" height="4284" alt="IMG_5425" src="https://github.com/user-attachments/assets/8b8d7529-4ce2-4ff0-8cb0-3de2543c0370" />


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
│ local-status │                            │              │
├──────────────┤                            │  git-notiql  │
│              │        plain shell         │              │
│  worktrees   │      (your terminal)       │              │
│  + agents    │                            ├──────────────┤
│ (cursor-     │                            │              │
│  status)     │                            │ notion-todo  │
└──────────────┴────────────────────────────┴──────────────┘
   left, 15%            middle, 70%              right, 15%
```

- **`git-notiql`** — GitHub PR radar: badges for replies on your own PRs, participating threads where you're waiting on a reply, and pending review requests. (Cmd-click a badge → the comment.)
- **`local-status`** — CPU / memory / what's on port 3000.
- **`notion-todo`** — type a to-do, Enter, it lands under this week's toggle in Notion.
- **middle panes** — plain shells for actual work.

Every widget is the same shape: small, self-refreshing, colored, OSC-8 clickable
links (iTerm2). Swap what runs where in the `CONFIG` block of `termdash`.

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
| `worktree -b <branch>` | Create a **new** branch off origin's default HEAD, in a sibling `<repo>-worktrees/<last-segment>` dir, provision it, `cd` in, and open it in a new Cursor window. |
| `worktree <branch>` | Same, for an **existing** (local or remote) branch. |
| `worktree rm` | Remove the worktree you're **standing in** — merged or not (type `delete` to confirm). Moves your shell back to the main checkout. |
| `worktree clean [-y]` | Remove **all** worktrees whose GitHub PR has merged (uses `gh`, so squash-merges count). Skips dirty ones; `-y` skips the prompt. |

Worktrees are created as a **sibling** dir (`popmenu` → `popmenu-worktrees/foo`),
never nested inside the main checkout — a nested path confuses Cursor about which
window owns a file, so diff/file links open in the wrong window.

### What creation provisions

A fresh worktree is missing everything gitignored, so `worktree -b` copies/links
it in. All steps are guarded by existence checks — **they no-op outside the
popmenu repo**:

- symlinks `.husky/_` back to the main checkout (so the pre-commit hook works);
- copies the gitignored `.env` / `.env.*` and `.bundle/config` over;
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
Activity Monitor deep-links assume iTerm2.

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
export CIRCLECI_TOKEN="..."            # cursor-status (the ● CI dots in the worktrees panel)
export NOTION_TOKEN="ntn_..."          # notion-todo
export NOTION_PAGE_ID="..."            # notion-todo (page to append to; 32-char id from its URL)
```

After editing, `source ~/.zshrc` (or `termdash restart` from a fresh shell) so
the panes inherit the new values.

#### Where to get each token

| Env var | Used by | Where to get it | Scope needed |
|---------|---------|-----------------|--------------|
| `GITHUB_TOKEN` | `git-notiql.ts` | GitHub → Settings → Developer settings → **Personal access tokens**. Classic is simplest. | `repo` (read private repos) + `read:user`. Authorize SSO for your org if it enforces SAML. |
| `CIRCLECI_TOKEN` | `cursor-status.ts` | CircleCI → **User settings → Personal API Tokens**: <https://app.circleci.com/settings/user/tokens> | Personal API token (read is enough). |
| `NOTION_TOKEN` | `notion-todo.ts` | Notion → <https://www.notion.so/my-integrations> → **New integration** (internal). Copy the secret. Then **share the target page with the integration** (page → ••• → Connections), or it can't write. | Insert content on the shared page. |

`local-status.ts` needs **no tokens**. `cursor-status.ts` needs `CIRCLECI_TOKEN`
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

> `notion-todo.ts`'s target page is **not** hardcoded — set the `NOTION_PAGE_ID`
> env var (step 4) to the Notion page **you** want to-dos appended to.

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
- **Worktrees panel shows gray dots / no PR glyph** — `CIRCLECI_TOKEN` unset (CI
  dots) or `gh` not authenticated (`gh auth status`) for the PR/merged glyphs.
- **Emoji/links render oddly** — the widgets target iTerm2; other terminals may
  mangle OSC 8 links and wide glyphs.

</details>
