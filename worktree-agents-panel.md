# Worktree + Agent panel — design notes

**Goal:** make git worktrees and the Cursor agent(s) working in them easier to
track and manage from the term-dash dashboard. Not "list cursor agents" in the
abstract — the unit of work is a **worktree**, and each worktree has one (maybe
two) agents churning in it. The panel answers, at a glance:

- Which worktrees do I have open, and on what branch?
- What's the agent in each one doing — running, done, or errored?
- Which of them need me to do something?
- Click a row → jump to that worktree's Cursor window.

Working model: **one agent per worktree** (occasionally two). A worktree is a
directory; a Cursor window is opened on a directory; a `cursor-agent` session
is filed under a directory. So everything joins on the **directory path**.

## The join (the key idea)

`directory path` is the primary key that ties all three data sources together:

```
git worktree list           ~/.cursor/projects/<enc>/          cursor://file/<path>
──────────────────          ─────────────────────────         ────────────────────
/Code/popmenu-wt/sc-123  →  encode "/"→"-", drop leading "/"  → focus Cursor window
  branch: sc-123/foo         Users-colinsteele-Code-...          on that folder
  HEAD: a1b2c3d              /agent-transcripts/<uuid>/<uuid>.jsonl
                             → per-agent state
```

- **Encoding** (verified): a path like `/Users/colinsteele/Code/popmenu`
  becomes the project dir `Users-colinsteele-Code-popmenu` — drop the leading
  `/`, replace every `/` with `-`. Going *forward* (worktree path → project
  dir) is unambiguous, so we always encode, never decode. (Decoding is
  ambiguous because real folder names can contain `-`, e.g. `term-dash` — we
  avoid that by only ever going path → encoded.)
- **Data sources confirmed present on this machine:**
  - `git worktree list` works per repo (`~/Code/popmenu`, `~/Code/popship`).
  - `~/.cursor/projects/<enc>/agent-transcripts/<uuid>/<uuid>.jsonl` — one
    JSONL transcript per CLI agent session. ~236 sessions across projects.
  - `cursor://file/<abspath>` is a registered, working URL scheme (Cursor
    claims `cursor:` for `public.folder`); `open "cursor://file/<dir>"`
    focuses/opens the window on that folder.

## Update (2026-07-15): CI baked in + process-based running signal

The panel now does two jobs in one row (`cursor-status.ts`):

- **CI status** = the colored `●` dot LEFT of the branch name (CircleCI,
  keyed to the worktree's branch via `pipeline/mine`). cmd-click the dot →
  CircleCI workflow. This folds the standalone circle-status functionality in;
  no "which job failed" needed — cmd-click the name to jump in and fix it.
- **Agent state** = the trailing glyph (`▸` running · `✓` done · `✗` attn ·
  dim `·` none). cmd-click the name → `cursor://file/<path>`.

CI is best-effort: no `CIRCLECI_TOKEN` → dots stay gray, agents still render.
Repo→slug map lives in the `REPOS` config (popmenu, popship).

### The running-detection fix (the important part)

Transcript **mtime is NOT a reliable "running" signal.** An agent busy inside a
long tool call — or churning in a *subagent* transcript — can leave its own
`<uuid>.jsonl` untouched for many minutes. The old 20s-mtime window therefore
reported "0 running" while two agents were actively working. Observed live:
`migrate-shortcut` and `4-add-evaluation-hook` had transcripts 6–9 min stale but
were mid-run.

The reliable signal is Cursor's per-worktree extension host process:

```
Cursor Helper (Plugin): extension-host (agent-exec) <basename> [n-m]
```

Parse `ps -axo command` for `(agent-exec) <name> [n-m]`; `<name>` is the worktree
**basename**. That process is alive whenever a Cursor window has an agent on that
folder — so it means "agent attached," not "generating right now." Combine it
with the transcript's last record to get the state:

| live process | last record | → state |
|---|---|---|
| yes | no terminal `turn_ended` (turn open) | 🏃 running |
| yes / no | `turn_ended status:error` | ✗ needs attention |
| yes / no | `turn_ended status:success` | ✓ done (idle window if process still up) |
| no | turn open but stale | ✓ done (window closed mid-transcript / old format) |

Two robustness notes baked into `rollupAgent`: (1) check *any* of the 2 most-
recent sessions for an open turn, not just the newest-by-mtime — a running
agent's transcript can be older than a sibling session that just finished; (2)
`newestActivity()` folds in `subagents/*.jsonl` mtimes so sort order and the
mtime fallback track subagent churn. Basename matching can't disambiguate two
worktrees that share a basename across repos (rare; accepted).

## Agent state detection (from the transcript)

Each `<uuid>.jsonl` ends with a control record that tells us the state. Scanned
across all sessions, every one falls into these buckets:

| Last non-empty record | Meaning | Badge |
|---|---|---|
| `{"type":"turn_ended","status":"success"}` | turn finished cleanly | ✅ done |
| `{"type":"turn_ended","status":"error","error":"…"}` | aborted / disconnected / out-of-usage | ❌ needs attention |
| bare assistant message, no `turn_ended` (older transcripts) | finished, pre-marker format | ✅ done |

Runtime overlay for "running": a transcript whose **mtime is within the last
~20s and has no terminal marker yet** (optionally corroborated by a live
`cursor-agent` process) is 🏃 running.

Observed error strings (all from `turn_ended`/`status:error`): `"User aborted
request"`, `"Workspace Disconnected …"`, `"You're out of usage …"`. The
out-of-usage / disconnected ones are the genuinely actionable errors.

Title for a row: the first `<user_query>` block in the transcript (first user
message), trimmed.

## Click behavior

Rows are OSC-8 hyperlinks (same `link()` helper as the other widgets):

```
cursor://file/<worktree-abs-path>
```

Cmd/ctrl-click focuses the **existing** Cursor window for that folder (Cursor,
like VS Code, reuses the window already open on a folder rather than spawning a
duplicate) — or opens it if none is open. This is the closest achievable thing
to "open the window where that agent lives": the relationship is
session → project/worktree dir → the window on that dir.

## Constraints / things that are NOT possible (verified)

- **No async "agent is waiting on you / asked a question" state.** A local CLI
  turn is either running or over (`turn_ended`). So the clean signals are
  running / done / errored — not a mid-run "needs your reply" pause like cloud
  agents have. For local CLI that's fine: you're at the terminal when it asks.
- **Can't reopen a specific past session in the Cursor GUI.** Cursor's
  deeplinks (`cursor://anysphere.cursor-deeplink/…`) only create *new*
  prompts/commands/rules — there's no "open chat by id". And terminal
  `cursor-agent` sessions are a separate store from the GUI Composer chats.
  Best we can do is focus the *window on the worktree folder* (above), or, for
  a true resume, `cursor-agent --resume <uuid>` in a terminal pane.
- **Can't map an agent to an exact window when two windows share a folder.**
  Focusing is folder-granular. Raising a *specific* window by title would need
  AppleScript System Events, which currently lacks Accessibility permission
  (grant Terminal/iTerm accessibility to enable a title-match raise later).
- **No Cursor API / API key involved** — this is 100% local files + the URL
  scheme. No `CURSOR_API_KEY` needed. (A separate cloud-agents path exists via
  `https://api.cursor.com/v1/agents` if we ever want background/cloud agents,
  but that's out of scope here.)

## Proposed panel (`cursor-status.ts` / worktrees widget)

Right-column widget, same style as the others (compact, colored, self-refresh,
OSC-8 links, `--mock`). Scope: **recent across all projects/worktrees**, newest
first, capped ~8–10 rows.

```
WORKTREES + AGENTS                         (updated 3:14 PM, every 30s)
────────────────────────────────────────────────────────────────────
 ❌ popship   sc-162243/flaky-test-service     2m   out of usage
 🏃 popmenu   sc-171002/campaign-builder       now
 ✅ popmenu   master                           14m
 ✅ term-dash main                             1h
────────────────────────────────────────────────────────────────────
 1 running   2 done   1 needs attention
```

Each row: state badge · repo · branch (from `git worktree list`) · age (agent
transcript mtime) · error note if any. Whole row links to
`cursor://file/<worktree-path>`.

## Build steps

1. Enumerate worktrees: `git worktree list --porcelain` for each repo in a
   configurable `REPOS` list (start with `~/Code/popmenu`, `~/Code/popship`).
2. For each worktree path: encode → look up `~/.cursor/projects/<enc>/agent-transcripts/`,
   collect sessions, read each transcript's last non-empty line for state +
   mtime + first `<user_query>` for a title.
3. Fold to one (or two) most-recent agents per worktree; classify
   running/done/error.
4. Render sorted by activity; each row an OSC-8 link to `cursor://file/<path>`.
5. Refresh loop (~30s; cheap, all local FS + `git`).

## Open questions

- One row per **worktree** (roll up its agents into the worst/most-recent
  state) or one row per **agent session**? Leaning per-worktree, with a count
  badge if >1 agent.
- Include worktrees that have *no* agent sessions yet (just show the branch),
  or only worktrees with agent activity?
- Auto-discover repos (scan `~/Code/*` for git repos) vs. an explicit `REPOS`
  list?
