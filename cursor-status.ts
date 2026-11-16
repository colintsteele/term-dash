#!/usr/bin/env -S npx tsx
/**
 * Worktree panel — one row per git worktree, combining TWO signals:
 *
 *   1. CI status (CircleCI)  → the colored ● dot LEFT of the branch name.
 *        red = failed · yellow = running/on_hold · green = passed · gray = unknown.
 *        cmd/ctrl-click the DOT → opens that pipeline's workflow in CircleCI.
 *   2. Git/PR                 → the ⎇ glyph between the dot and the branch name.
 *        cmd/ctrl-click it → the branch's GitHub PR (dim if the repo has no
 *        GitHub slug configured). Turns into a purple ↥ when the PR is MERGED —
 *        i.e. this worktree is ready to reap with `worktree clean`. Desaturated
 *        (dim magenta) while the branch has no `origin/<branch>` yet: nothing is
 *        pushed, so there cannot be a PR behind the link.
 *   2b. Shortcut ticket       → a cyan ◆ right after the ⎇, shown when the branch
 *        has an sc-<id>. cmd/ctrl-click → the Shortcut story (app.shortcut.com).
 *   2c. hubdiff               → a white ± right after the ◆, on every row.
 *        cmd/ctrl-click → this worktree's diff in the native Hubdiff.app via its
 *        own URL scheme (hubdiff://?repo=<url-encoded worktree path>), which
 *        repoints the already-open window. Deliberately NOT a browser link: the
 *        diff viewer is its own app, not another Chrome tab.
 *   3. Cursor agent state     → the trailing glyph after the branch name.
 *        (anim) running · ✓ done · !! waiting on you (a question) · ✗ error ·
 *        (dim) no agent.  cmd/ctrl-click the NAME → focuses that Cursor window.
 *   4. Dev server             → a blue ◂ right after the branch name marks the
 *        worktree whose directory is serving localhost:DEV_PORT (found by
 *        matching the listening process's cwd to the worktree path).
 *   5. The repo's MAIN checkout (popmenu's master) gets a row too, pinned FIRST and
 *        deliberately bare: CI dot, name, and the agent/dev markers only. No ⎇/◆/±,
 *        no approvals, no failing-job indents — master isn't a unit of work, it has
 *        no PR or story, and its diff is the baseline the other rows diff against.
 *        It's there to cmd-click into that repo's Cursor window. Only rendered for
 *        repos that actually have linked worktrees. See `isMain`.
 *
 * This widget REPLACES the standalone circleci panel: CI is now folded in
 * here, keyed to the worktrees you actually have open, so there's no need to
 * surface "which job failed" — cmd-click the dot for CI, cmd-click the name to
 * jump into the worktree and fix it.
 *
 * ── Joins (see worktree-agents-panel.md) ──────────────────────────────────
 *   git worktree list  →  worktree path + branch
 *   path → encode (/ → -, drop leading /) → ~/.cursor/projects/<enc>/agent-transcripts/…
 *   branch → CircleCI `pipeline/mine` (per repo slug) → workflow status
 *   basename(path) → live `agent-exec <basename>` process → "agent running now"
 *
 * ── Why a live-process check for "running" ────────────────────────────────
 * Transcript mtime is NOT a reliable running signal: an agent busy inside a
 * long tool call (or a subagent) can go minutes without touching its own
 * transcript, so a "recently modified" window misses genuinely-running agents.
 * The reliable signal is Cursor's per-worktree extension host:
 *     Cursor Helper (Plugin): extension-host (agent-exec) <basename> [n-m]
 * That process is alive while a Cursor window has an agent on that folder. We
 * combine it with the transcript's last record: a live process whose latest
 * turn hasn't closed (no terminal `turn_ended`) = running; a live process
 * whose last turn ended in error = error; ended cleanly = done/idle.
 *
 * ── Why "waiting on you" comes from Cursor's SQLite, not the transcript ─────
 * When the agent calls its AskQuestion tool and blocks on your answer, that
 * pending question is INVISIBLE in the jsonl transcript: an assistant message
 * is only flushed once its tool call completes (after you answer), so while the
 * agent waits, the transcript's last record is just the previous completed step
 * with an open turn — indistinguishable from an agent mid-think or mid-long-
 * tool-call. Transcript mtime doesn't help either: a working agent can go quiet
 * for minutes (long Shell), and terminal files keep churning from background
 * watchers. The one reliable signal is Cursor's own conversation store
 * (globalStorage/state.vscdb), which updates in real time and tags each tool
 * call's answer state. A latest tool call of `ask_question` whose
 * `toolFormerData.additionalData.status` is still `pending` (not submitted /
 * cancelled / error) = a live, unanswered question → "waiting". NOTE it's the
 * INNER additionalData.status that tracks your answer; the outer tool `status`
 * flips to `completed` the moment the model emits the question, so it's useless
 * for "did they answer yet". See pendingQuestion().
 *
 * All local except the CircleCI read. No accessibility permission needed.
 *
 * SETUP:
 *   export CIRCLE_CI_TOKEN=...  # optional; without it, CI dots stay gray
 *                                (CIRCLECI_TOKEN is honored as a fallback)
 *   npx tsx cursor-status.ts
 * TESTING:
 *   npx tsx cursor-status.ts --mock   # one fixed frame, no FS/git/network
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();

// Repos to scan for worktrees. `slug` is the CircleCI project slug used to pull
// CI status for that repo's branches (null = no CI lookup for this repo).
const REPOS: { dir: string; slug: string | null }[] = [
  { dir: path.join(HOME, "Code/popmenu"), slug: "gh/Popmenu/popmenu" },
  { dir: path.join(HOME, "Code/popship"), slug: "gh/Popmenu/popship" },
  { dir: path.join(HOME, "Code/term-dash"), slug: null },
];

const AGENT_REFRESH_SECONDS = 5; // agents are a local read (git + transcripts + ps) — poll them fast
const CI_REFRESH_SECONDS = 30; // CI is a network read — poll it slow, render from cache in between
const ANIM_INTERVAL_MS = 500; // running-glyph animation frame; ~2s per full sweep over RUN_TRACK slots
const MAX_ROWS = 12;
const RUNNING_WINDOW_MS = 20_000; // transcript touched this recently + turn open = running (fallback)

// Two CircleCI vars exist in this shell and only one works: CIRCLECI_TOKEN was
// revoked (401 on every endpoint, including /me) while CIRCLE_CI_TOKEN is live.
// Prefer the working one -- same fallback herdr-sync.ts uses. Reading only the
// dead name silently 401d every CI call and greyed out every dot, and the
// "no token" warning below stayed quiet because the var WAS set, just worthless.
//
// Collapse this to a single var once the dead token is rotated out of keys.zsh.
const CIRCLECI_TOKEN = process.env.CIRCLE_CI_TOKEN || process.env.CIRCLECI_TOKEN;
const CIRCLECI_API = "https://circleci.com/api/v2";

// Sentry. Read-only, and used for exactly two things: deciding that a branch is a
// FIX rather than a feature, and putting a clickable △ on the row.
//
// us.sentry.io, not sentry.io: the regional host is what serves issue and shortid
// endpoints for this org. (morning-brief.ts learned the same thing — see the note
// above its SENTRY_API.)
const SENTRY_TOKEN = process.env.SENTRY_AUTH_TOKEN;
const SENTRY_API = "https://us.sentry.io/api/0";
const SENTRY_ORG = "popmenu";
// A short id is <PROJECT>-<SUFFIX> and the suffix alone is not addressable, so a
// bare suffix off a worktree directory has to be tried against each project.
const SENTRY_PROJECT_PREFIXES = ["POPMENU-WEB-RAILS", "POPMENU-WEB-REACT"];
// Outline triangle, to pair with the filled ◆ of the Shortcut story beside it and
// echo Sentry's own chevron mark. Ambiguous-width like ◆, which this pane already
// renders at one cell, so it costs the same two cells every other glyph does.
const SENTRY_GLYPH = "△";

// Architecture review. Popmenu gates a set of paths — migrations, schema, Sidekiq
// config, secrets, the security-check allowlists — behind @Popmenu/architecture in
// CODEOWNERS. Touching one means the PR needs THAT team's approval on top of the
// usual two, and it is the approval most likely to be the one you are waiting on.
//
// Computed from CODEOWNERS against the worktree's own diff, NOT from GitHub's
// reviewRequests. Checked first and rejected: this repo does not auto-request the
// team (PR 35906 touches `db/migrate` and its reviewRequests array is empty), so
// asking GitHub would have reported "not needed" on exactly the PRs that need it.
// Reading the diff also means the marker appears the moment you add a migration,
// before any PR exists at all.
const ARCH_TEAM = "@Popmenu/architecture";
const ARCH_TEAM_API = "Popmenu/architecture";
const ARCH_GLYPH = "A";

// ANSI
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";
const MAGENTA = "\x1b[35m";
const PURPLE = "\x1b[38;2;137;87;224m"; // GitHub "merged" hue — distinguishes merged from open-PR magenta
// Unpushed-branch ⎇: same hue as the open-PR glyph, muted by the terminal's own dim
// attribute rather than a hardcoded RGB, so it tracks MAGENTA if that ever changes
// and stays readable on any background. Distinct from bare DIM (no-GitHub-slug),
// which keeps the default foreground.
const DIM_MAGENTA = DIM + MAGENTA;
const WHITE = "\x1b[97m";
// Sentry's brand violet (#6C5FC7). Close to PURPLE above, but they never share a
// column — PURPLE is the merged-PR ↥, this is the △ two glyphs to its right.
const SENTRY_VIOLET = "\x1b[38;2;108;95;199m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

function link(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

// Every http link in this panel goes through webLink, which optionally routes it
// through the `termdash:` scheme so a cmd-click REUSES the Chrome tab you already
// have open for that PR / story / workflow / diff instead of stacking duplicates.
// An OSC 8 sequence carries only a URI — there's no "reuse a tab" flag — so the
// redirect through a scheme we own (handled by TermDashOpen.app → tab-open.sh) is
// the only place that intent can live. See tab-reuse.md for the install.
//
// The payload is percent-encoded because the inner URL has its own ? and #: nested
// raw, NSURL reads them as the OUTER url's query/fragment and mangles the link.
//
// OFF unless TERMDASH_REUSE_TABS=1, because a `termdash:` link is inert on a
// machine without the handler installed — anyone else cloning this repo gets plain
// URLs and today's new-tab behavior.
const REUSE_TABS = process.env.TERMDASH_REUSE_TABS === "1";

function webLink(text: string, url: string): string {
  return link(text, REUSE_TABS ? `termdash:${encodeURIComponent(url)}` : url);
}

// ── agent state ────────────────────────────────────────────────────────────

type AgentState = "running" | "waiting" | "done" | "error" | "none";

interface Agent {
  uuid: string;
  mtime: number;
  state: AgentState; // done/error from the transcript alone (running is decided later, with the process signal)
  closed: boolean; // last record was a terminal turn_ended (clean OR error)
  note?: string; // short error note
  title?: string; // first user query
}

// ── CI status ──────────────────────────────────────────────────────────────

type WorkflowStatus =
  | "success"
  | "running"
  | "on_hold"
  | "failed"
  | "failing"
  | "error"
  | "canceled"
  | "not_run"
  | "unauthorized";

type CiStatus = WorkflowStatus | "unknown";

// A single failed job within a failing workflow, linked to its own CircleCI
// job page (deeper than the workflow URL on the CI dot).
interface CiJob {
  name: string;
  url: string;
}

interface Ci {
  status: CiStatus;
  url?: string;
  failedJobs?: CiJob[]; // populated only when status is a failing one
}

// Shape of a job in CircleCI's `/workflow/{id}/job` response (subset we use).
// `job_number` is absent for approval/blocked jobs — those have no job page.
interface CircleJob {
  id: string;
  name: string;
  status: string;
  job_number?: number;
  type?: string;
}

interface Worktree {
  repo: string; // label (basename of the repo we scanned)
  wtPath: string; // absolute worktree path
  branch: string;
  agent?: Agent; // the worktree's most recently touched agent session (see newestAgentFor)
  isMain: boolean; // the repo's main checkout (master), not a linked worktree — bare row, see render()
  scTier?: ScTier; // Shortcut story pipeline tier, drives the ◆ colour (undefined = unknown/no token)
  mtime: number; // most-recent agent activity (0 if none)
  agentState: AgentState; // rolled-up agent badge
  ci: Ci;
  prUrl?: string; // GitHub PR for this branch (undefined = repo has no GitHub slug)
  hasPr?: boolean; // gh resolved a real PR for this branch (prUrl alone may be the search fallback)
  pushed: boolean; // `origin/<branch>` exists locally → the branch is on the remote, so a PR is possible
  approvals: number; // # of APPROVED reviews on that PR (0 if none / no PR / not resolved yet)
  merged: boolean; // the branch's most recent PR is MERGED → worktree is `worktree clean`-able
  devRunning: boolean; // a process serving DEV_PORT has its cwd inside this worktree
  arch?: ArchState; // this branch touches @Popmenu/architecture-owned paths (undefined = it doesn't)
}

// CircleCI slug ("gh/Popmenu/popmenu") → "owner/repo", or null for non-gh slugs.
function githubRepo(slug: string): string | null {
  const m = slug.match(/^gh\/([^/]+)\/([^/]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Head-ref search URL for a branch — the graceful fallback when `gh` hasn't
// resolved a direct PR link yet (or isn't installed/authed). Always lands
// somewhere useful; the direct /pull/<n> link from resolvePrUrl is preferred.
function prSearchUrl(slug: string, branch: string): string | undefined {
  const repo = githubRepo(slug);
  if (!repo) return undefined;
  const q = encodeURIComponent(`is:pr head:${branch}`);
  return `https://github.com/${repo}/pulls?q=${q}`;
}

// Resolve the direct GitHub PR URL for a branch via `gh` (uses the PR number),
// its current approval count, and whether it's merged. `--state all` (not open)
// so a merged PR still resolves — that's what drives the ↥ merged glyph and tells
// you the worktree is `worktree clean`-able. `--limit 1` takes the MOST RECENT PR
// for the head (created desc), so a reused branch reflects its current PR, not a
// stale merged one. `latestReviews` rides along in the SAME `gh` call (one entry
// per reviewer already), so counting APPROVED costs no extra request — free
// alongside the URL. Returns url:null if gh is missing/unauthed, there's no PR, or
// the lookup errors — callers fall back to prSearchUrl. Network call, so this only
// runs on the slow lane. `timeout` guards against gh hanging.
function resolvePr(slug: string, branch: string): { url: string | null; approvals: number; merged: boolean; approvers: string[] } {
  const repo = githubRepo(slug);
  const none = { url: null, approvals: 0, merged: false, approvers: [] as string[] };
  if (!repo) return none;
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--repo", repo, "--head", branch, "--state", "all",
       "--json", "url,state,latestReviews", "--limit", "1",
       // `approvers` rides along in the same request as `approvals`, from the
       // same array — it is what tells an architecture approval from any other.
       "--jq", '.[0] // empty | {url, merged: (.state == "MERGED"), approvals: ([.latestReviews[] | select(.state=="APPROVED")] | length), approvers: [.latestReviews[] | select(.state=="APPROVED") | .author.login]}'],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }
    ).trim();
    if (!out) return none;
    const o = JSON.parse(out);
    return { url: o.url ?? null, approvals: o.approvals ?? 0, merged: o.merged ?? false, approvers: o.approvers ?? [] };
  } catch {
    return none;
  }
}

// ---- git worktrees ----

// Which of `branches` have been pushed, i.e. have a local `refs/remotes/origin/<b>`.
// This is the gate on "can a PR even exist", and it's what desaturates the ⎇ glyph.
//
// NOT `@{u}`/branch.upstream: `worktree -b foo` branches off origin/master, and with
// git's default branch.autoSetupMerge that sets foo's upstream to *origin/master*.
// So a never-pushed branch HAS an upstream, and @{u} would report the row as pushed
// on exactly the branches we want dimmed. The remote-tracking ref for the branch
// itself is the honest signal.
//
// One git call per repo, not per branch: passing the refs as explicit patterns keeps
// the output to the handful we asked about instead of enumerating every remote ref
// (~30ms vs ~110ms on a repo with 4k+ branches). Patterns also match one level down
// (`…/origin/a/b` matches pattern `…/origin/a`), so we compare the RETURNED names
// exactly rather than trusting "the pattern matched something".
//
// Freshness: `git push` writes refs/remotes/origin/<branch> in the repo you pushed
// from, so a push anywhere in this repo shows up here on the next 5s tick with no
// fetch. Pushing from a DIFFERENT clone stays dim until something fetches.
//
// Returns null when we can't tell (git failed, or the repo has no origin refs at
// all) so callers can fail open and leave the glyph at full saturation — better a
// missed dim than every row in a remote-less repo washed out.
function pushedBranches(repo: string, branches: string[]): Set<string> | null {
  if (branches.length === 0) return null;
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["-C", repo, "for-each-ref", "--format=%(refname:lstrip=3)",
       ...branches.map((b) => `refs/remotes/origin/${b}`)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    return null; // not a repo / git missing
  }
  const names = out.split("\n").map((l) => l.trim()).filter(Boolean);
  // No origin refs matched AND the repo has no origin at all → "can't tell". A repo
  // WITH an origin that simply matched nothing is a real all-unpushed answer, so
  // only the missing-remote case fails open.
  if (names.length === 0 && !hasOrigin(repo)) return null;
  return new Set(names);
}

// Does this repo have any `origin` remote-tracking refs? Only consulted to
// disambiguate an empty pushedBranches() result, so it costs nothing in the
// common case. `--count` keeps it O(1) output regardless of branch count.
function hasOrigin(repo: string): boolean {
  try {
    const n = execFileSync(
      "git",
      ["-C", repo, "for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes/origin"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return n.length > 0;
  } catch {
    return false;
  }
}

function listWorktrees(repo: string): { wtPath: string; branch: string }[] {
  let out: string;
  try {
    out = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"], // don't leak "not a git repository" to our pane
    });
  } catch {
    return []; // not a repo / git missing
  }
  const worktrees: { wtPath: string; branch: string }[] = [];
  let cur: { wtPath: string; branch: string } | null = null;
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) {
      if (cur) worktrees.push(cur);
      cur = { wtPath: line.slice("worktree ".length), branch: "(detached)" };
    } else if (line.startsWith("branch ")) {
      if (cur) cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      if (cur) cur.branch = "(detached)";
    }
  }
  if (cur) worktrees.push(cur);
  return worktrees;
}

// ---- live agent processes ----

// Set of worktree basenames that currently have a live Cursor agent extension
// host, e.g. "extension-host (agent-exec) migrate-shortcut [4-41]".
function liveAgentDirs(): Set<string> {
  const names = new Set<string>();
  let out: string;
  try {
    out = execFileSync("ps", ["-axo", "command"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return names;
  }
  for (const line of out.split("\n")) {
    const m = line.match(/\(agent-exec\)\s+(.+?)\s+\[\d+-\d+\]/);
    if (m) names.add(m[1].trim());
  }
  return names;
}

// ---- dev server → which worktree is serving it ----

// The local dev server's port. A worktree is flagged as "serving dev" when the
// process listening here has its cwd inside that worktree.
const DEV_PORT = 3000;

// cwd(s) of whatever is listening on DEV_PORT. Two-step lsof: port → PID(s),
// then PID → cwd (a port has no branch/dir of its own; the dir belongs to the
// serving process). Local + cheap, so it rides the fast gather() tick. Any
// failure (nothing listening, lsof missing) → empty set = "nobody's serving".
function devServerDirs(): Set<string> {
  const dirs = new Set<string>();
  let portOut: string;
  try {
    portOut = execFileSync("lsof", ["-nP", `-iTCP:${DEV_PORT}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return dirs; // nothing listening (lsof exits non-zero) or lsof absent
  }
  const pids = new Set<number>();
  for (const line of portOut.trim().split("\n").slice(1)) {
    // COMMAND PID USER … — the PID is the second column
    const pid = parseInt(line.split(/\s+/)[1], 10);
    if (!Number.isNaN(pid)) pids.add(pid);
  }
  for (const pid of pids) {
    try {
      const cwdOut = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      // -Fn field output: the cwd path arrives on a line prefixed with "n"
      const cwd = cwdOut.split("\n").find((l) => l.startsWith("n"))?.slice(1).trim();
      if (cwd) dirs.add(cwd);
    } catch {
      /* PID gone between the two lsof calls, or no cwd — skip */
    }
  }
  return dirs;
}

// ---- transcript → agent state ----

function encodeProject(p: string): string {
  return p.replace(/^\//, "").replace(/\//g, "-");
}

function shortNote(err: string): string {
  if (/out of usage|increase.*limit/i.test(err)) return "out of usage";
  if (/disconnect/i.test(err)) return "disconnected";
  if (/aborted/i.test(err)) return "aborted";
  return err.split(/\s+/).slice(0, 3).join(" ").slice(0, 24);
}

function firstUserQuery(lines: string[]): string | undefined {
  for (const l of lines) {
    let o: any;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (o?.role !== "user") continue;
    const content = o?.message?.content;
    const text = Array.isArray(content)
      ? content.map((c: any) => c?.text ?? "").join(" ")
      : typeof content === "string"
        ? content
        : "";
    const m = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
    const q = (m ? m[1] : text.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "")).trim();
    if (q) return q.replace(/\s+/g, " ").slice(0, 60);
    return undefined;
  }
  return undefined;
}

// Newest mtime among a session's own transcript and any subagent transcripts —
// a running agent often churns only in a subagent, leaving the main file stale.
function newestActivity(sessionDir: string, uuid: string): number {
  let newest = 0;
  const files = [
    path.join(sessionDir, `${uuid}.jsonl`),
    ...listSubagentTranscripts(path.join(sessionDir, "subagents")),
  ];
  for (const f of files) {
    try {
      newest = Math.max(newest, fs.statSync(f).mtimeMs);
    } catch {
      /* gone between readdir and stat */
    }
  }
  return newest;
}

function listSubagentTranscripts(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function readAgent(sessionDir: string, uuid: string): Agent | null {
  const file = path.join(sessionDir, `${uuid}.jsonl`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;

  const mtime = newestActivity(sessionDir, uuid);

  const last = lines[lines.length - 1];
  let state: AgentState = "done";
  let closed = false;
  let note: string | undefined;
  try {
    const o = JSON.parse(last);
    if (o?.type === "turn_ended") {
      closed = true;
      if (o.status === "error") {
        state = "error";
        note = shortNote(String(o.error ?? "error"));
      } else {
        state = "done";
      }
    }
  } catch {
    // partial/streaming final line — treat as a turn still open (closed=false)
  }

  return { uuid, mtime, state, closed, note, title: firstUserQuery(lines) };
}

// The single most recently touched agent session for a worktree, or undefined if
// there are none. One row shows one agent: a worktree can accumulate many sessions
// over its life, and rolling several into one row meant a "×2" counter and a badge
// that mixed states from different runs. The newest session is the one you care
// about — it's what you were last doing there.
function newestAgentFor(wtPath: string): Agent | undefined {
  const dir = path.join(HOME, ".cursor", "projects", encodeProject(wtPath), "agent-transcripts");
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined; // no agent sessions for this worktree
  }
  let newest: Agent | undefined;
  for (const uuid of entries) {
    const a = readAgent(path.join(dir, uuid), uuid);
    if (a && (!newest || a.mtime > newest.mtime)) newest = a;
  }
  return newest;
}

// The badge for a worktree's newest agent session, using the live-process signal.
// "running" needs a live agent-exec process (or a very recently touched transcript)
// whose latest turn hasn't closed out.
//
// Deliberately reads ONLY the newest session. The previous version OR'd states
// across the two most recent sessions, which meant an old failed run pinned the row
// to ✗ forever — `agents.some(a => a.state === "error")` was checked first, so a
// later clean run couldn't clear it. Newest-only means the badge tracks what you
// last did in that worktree and settles as soon as that run does.
//
// "waiting" (blocked on your answer to an AskQuestion) is deliberately NOT
// decided here: a pending question is indistinguishable from "running" by the
// transcript alone (see the header note). gather() overlays "waiting" on top of
// a "running" state when pendingQuestion() confirms it from Cursor's own state.
function agentBadge(agent: Agent | undefined, live: boolean): AgentState {
  if (!agent) return live ? "running" : "none"; // process up, transcript not written yet
  if (agent.state === "error") return "error";
  // "running" = a turn that never closed out (no terminal turn_ended), backed by a
  // live agent-exec process for this worktree — or, failing that, a transcript
  // touched in the last few seconds.
  if (!agent.closed && (live || Date.now() - agent.mtime < RUNNING_WINDOW_MS)) return "running";
  return "done";
}

// Cursor persists live conversation state — bubbles plus per-tool-call status —
// in this SQLite DB, keyed by composerId, which is the SAME UUID as the agent
// transcript. Unlike the jsonl (buffered: an in-flight tool line isn't flushed
// until it completes), this updates in real time, so it's the only place a
// *pending* AskQuestion shows up while the agent is blocked on you.
const CURSOR_DB = path.join(
  HOME, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"
);

// Read one value from the Cursor DB. Read-only + short timeout so a concurrent
// Cursor write never blocks our tick; maxBuffer is generous because a
// composerData blob runs to a few hundred KB.
function cursorDb(query: string): string {
  return execFileSync("sqlite3", ["-readonly", CURSOR_DB, query], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 4000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

// An answered/settled question's additionalData.status lands in one of these;
// anything else (in practice "pending") means it's still waiting on you.
// Denylisting the settled states (rather than matching "pending") keeps us
// correct if Cursor renames the waiting status, while still clearing a question
// you submitted, dismissed/cancelled, or that errored out.
const RESOLVED_QUESTION_STATUS = new Set(["submitted", "cancelled", "error"]);

// True when this composer's most-recent tool call is an AskQuestion you haven't
// answered yet — i.e. the agent is blocked waiting for you. The tell is the
// bubble's toolFormerData.additionalData.status: "pending" until you respond,
// then "submitted"/"cancelled"/"error". (The OUTER toolFormerData.status is a
// red herring — it's "completed" the instant the model finishes emitting the
// question, regardless of your answer.) Any read/parse failure → false, so we
// degrade to the transcript-based rollup.
function pendingQuestion(uuid: string): boolean {
  let headers: any[];
  try {
    const composer = cursorDb(`SELECT value FROM cursorDiskKV WHERE key='composerData:${uuid}';`);
    if (!composer.trim()) return false;
    headers = JSON.parse(composer).fullConversationHeadersOnly;
  } catch {
    return false; // no sqlite3 / DB locked / not this machine / no such composer
  }
  if (!Array.isArray(headers)) return false;

  // Walk back to the last header that is an actual tool call (text/thinking
  // bubbles carry no toolCallCase). Only a *trailing* ask_question is pending —
  // an answered one earlier in the turn is followed by later tool calls.
  let lastTool: any;
  for (let i = headers.length - 1; i >= 0; i--) {
    if (headers[i]?.grouping?.toolCallCase) { lastTool = headers[i]; break; }
  }
  if (lastTool?.grouping?.toolCallCase !== "askQuestionToolCall") return false;

  // Confirm it's still unanswered via that bubble's tool-call status.
  try {
    const bubble = cursorDb(`SELECT value FROM cursorDiskKV WHERE key='bubbleId:${uuid}:${lastTool.bubbleId}';`);
    if (!bubble.trim()) return false;
    const answer = JSON.parse(bubble)?.toolFormerData?.additionalData?.status;
    return typeof answer === "string" && !RESOLVED_QUESTION_STATUS.has(answer);
  } catch {
    return false;
  }
}

// ---- Shortcut (story workflow state → ◆ colour) ----

// Read-only token, same one already exported in ~/.zsh-sources/exports.zsh. Without
// it the ◆ just stays neutral — the glyph and its link work regardless, exactly like
// CI dots staying gray without CIRCLECI_TOKEN.
const SHORTCUT_TOKEN = process.env.SHORTCUT_RO_TOKEN;
const SHORTCUT_API = "https://api.app.shortcut.com/api/v3";

// Where a story sits in the pipeline, collapsed to the handful of distinctions worth
// a colour. Deliberately coarser than Shortcut's 11 Delivery states: the question
// this glyph answers at a glance is "is this mine to push on, waiting on QA, or
// ready to ship".
type ScTier = "idle" | "active" | "qa" | "ship" | "done";

async function sc<T>(p: string): Promise<T> {
  const res = await fetch(`${SHORTCUT_API}${p}`, {
    headers: { "Shortcut-Token": SHORTCUT_TOKEN as string },
  });
  if (!res.ok) throw new Error(`${p} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// Bucket a workflow state. Matched on NAME first, then falling back to Shortcut's
// coarse `type`, because type alone can't answer this: "In Development",
// "Ready for QA", "In QA", "Ready for Merge" and "Ready for Deploy" are ALL
// type=started in the Delivery workflow, so type alone would collapse the whole
// middle of the pipeline into one colour.
//
// Name matching (not position) so it works across the Delivery / Discovery / Data
// workflows, which have different state counts and orderings — position 7 is
// "Ready for Merge" in Delivery but "Ready for Review" in Data.
//
// Order matters: the ship and QA names are checked before the type fallbacks,
// since they're type=started too.
function scTier(name: string, type: string): ScTier {
  const n = name.trim().toLowerCase();
  if (/ready for (merge|deploy|approval)/.test(n)) return "ship";
  if (/\bqa\b/.test(n)) return "qa";
  if (type === "done") return "done";
  if (type === "backlog" || type === "unstarted") return "idle";
  return "active";
}

// workflow-state id → tier, for every workflow in the workspace. Fetched once per
// process: states are workspace configuration and effectively never change while the
// widget is running, so re-fetching them on every slow tick would be pure waste.
let scStateTiers: Map<number, ScTier> | null = null;

interface ScWorkflow {
  states: { id: number; name: string; type: string }[];
}

async function loadScStateTiers(): Promise<Map<number, ScTier>> {
  const workflows = await sc<ScWorkflow[]>("/workflows");
  const map = new Map<number, ScTier>();
  for (const w of workflows) {
    for (const s of w.states) map.set(s.id, scTier(s.name, s.type));
  }
  return map;
}

// ---- CircleCI ----

async function cc<T>(p: string): Promise<T> {
  const res = await fetch(`${CIRCLECI_API}${p}`, {
    headers: { "Circle-Token": CIRCLECI_TOKEN as string },
  });
  if (!res.ok) throw new Error(`${p} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// worst-status-wins across a pipeline's workflows
function worstStatus(statuses: WorkflowStatus[]): CiStatus {
  const order: WorkflowStatus[] = ["failed", "failing", "error", "running", "on_hold", "success"];
  for (const s of order) if (statuses.includes(s)) return s;
  return statuses[0] ?? "unknown";
}

// The statuses we treat as "this needs your attention" — drives the red dot,
// the fail count, and whether we drill into individual jobs.
const FAILING_STATUSES = new Set<CiStatus>(["failed", "failing", "error"]);
function isFailing(s: CiStatus): boolean {
  return FAILING_STATUSES.has(s);
}

// CircleCI job statuses that count as a failure worth surfacing. "canceled" and
// "not_run" are intentionally excluded — they're noise, not a broken job.
const BAD_JOB_STATUS = new Set([
  "failed",
  "infrastructure_fail",
  "timedout",
  "terminated-unknown",
]);

// CI status for the given branches of one repo. Only resolves workflows for
// branches we actually care about (our open worktrees), so it stays a couple of
// API calls, not one-per-branch across all of `pipeline/mine`.
async function ciForRepo(slug: string, branches: Set<string>): Promise<Map<string, Ci>> {
  const map = new Map<string, Ci>();
  if (!CIRCLECI_TOKEN || branches.size === 0) return map;

  let mine: { items?: any[] };
  try {
    mine = await cc<{ items?: any[] }>(`/project/${slug}/pipeline/mine`);
  } catch {
    return map; // token/permissions/transient — leave dots gray
  }

  // keep only the most recent pipeline per (wanted) branch
  const latestByBranch = new Map<string, any>();
  for (const p of mine.items ?? []) {
    const branch =
      p.vcs?.branch || p.trigger_parameters?.git?.branch || p.trigger_parameters?.github_app?.branch;
    if (!branch || !branches.has(branch)) continue;
    const existing = latestByBranch.get(branch);
    if (!existing || p.number > existing.number) latestByBranch.set(branch, p);
  }

  for (const [branch, pipeline] of latestByBranch) {
    let workflows: { items?: { id: string; status: WorkflowStatus }[] };
    try {
      workflows = await cc<{ items?: { id: string; status: WorkflowStatus }[] }>(
        `/pipeline/${pipeline.id}/workflow`
      );
    } catch {
      continue;
    }
    const items = workflows.items ?? [];
    if (items.length === 0) continue;
    const status = worstStatus(items.map((w) => w.status));
    const target = items.find((w) => w.status === status) ?? items[0];
    const ci: Ci = {
      status,
      url: `https://app.circleci.com/pipelines/${slug}/${pipeline.number}/workflows/${target.id}`,
    };

    // On failure, drill one level deeper: pull the jobs of every failing
    // workflow and surface the ones that actually failed, each linked to its
    // own job page. Only runs for failing branches, so it adds API calls
    // exactly when there's something worth clicking into.
    if (isFailing(status)) {
      const failedJobs: CiJob[] = [];
      for (const wf of items) {
        if (!isFailing(wf.status)) continue;
        let jobs: { items?: CircleJob[] };
        try {
          jobs = await cc<{ items?: CircleJob[] }>(`/workflow/${wf.id}/job`);
        } catch {
          continue; // transient/permissions — skip this workflow's jobs
        }
        for (const j of jobs.items ?? []) {
          if (j.job_number == null || !BAD_JOB_STATUS.has(j.status)) continue;
          failedJobs.push({
            name: j.name,
            url: `https://app.circleci.com/pipelines/${slug}/${pipeline.number}/workflows/${wf.id}/jobs/${j.job_number}`,
          });
        }
      }
      if (failedJobs.length) ci.failedJobs = failedJobs;
    }

    map.set(branch, ci);
  }
  return map;
}

// ---- slow-lane cache (CI status + PR links) ----

// CI status and PR links are the two network reads, fetched on the slow cadence
// and cached here so the fast agent tick renders from memory without touching the
// network. Both keyed by slug+branch.
const ciCache = new Map<string, Ci>();
const prCache = new Map<string, string>(); // slug+branch → direct PR url (from gh)
const approvalsCache = new Map<string, number>(); // slug+branch → # APPROVED reviews (from gh)
const mergedCache = new Map<string, boolean>(); // slug+branch → most-recent PR is MERGED (from gh)
const archCache = new Map<string, ArchState>(); // worktree path → architecture-review state (absent = not gated)
const scTierCache = new Map<string, ScTier>(); // shortcut story id → pipeline tier (from the Shortcut API)
// The rest of the story, off the SAME request the tier comes from, so it is free.
// `story_type` is the cheapest "is this a fix" signal there is, and `description`
// is where a Sentry-filed ticket puts its issue link.
const scStoryCache = new Map<string, { type: string; description: string }>();
let slowFetchedAt = 0;
let slowInFlight = false;

function ciKey(slug: string, branch: string): string {
  // \0 as an escape, not a raw NUL byte: a literal NUL in the source makes grep
  // and file(1) classify this whole file as binary and skip it.
  return `${slug}\0${branch}`;
}

// Refresh the CI + PR caches for every repo's current worktree branches. Runs on
// the CI_REFRESH_SECONDS cadence, off the fast agent render path. ciForRepo and
// resolvePrUrl swallow their own errors (dots stay gray / no direct PR link), so
// this effectively never throws. PR resolution runs even without a CircleCI token
// — `gh` doesn't need it.
async function refreshSlow(): Promise<void> {
  slowInFlight = true;
  try {
    for (const repo of REPOS) {
      if (!repo.slug) continue;
      const wts = listWorktrees(repo.dir);
      // CI covers every branch INCLUDING the main checkout's — the ● dot is the one
      // signal the master row does carry.
      const branches = new Set(wts.map((w) => w.branch));
      if (CIRCLECI_TOKEN) {
        const map = await ciForRepo(repo.slug, branches);
        for (const [branch, ci] of map) ciCache.set(ciKey(repo.slug, branch), ci);
      }
      // PR resolution does NOT: master has no PR, so `gh pr list --head master`
      // is a guaranteed-empty network call on every slow tick. `git worktree list`
      // puts the main checkout first, so wts[0] identifies the branch to skip.
      const mainBranch = wts[0]?.branch;
      for (const branch of branches) {
        if (branch === mainBranch) continue;
        const { url, approvals, merged, approvers } = resolvePr(repo.slug, branch);
        // Only cache on a resolved PR, so a transient gh failure (url:null,
        // approvals:0) never clobbers a previously-known URL, approval count, or
        // merged flag.
        if (url) {
          prCache.set(ciKey(repo.slug, branch), url);
          approvalsCache.set(ciKey(repo.slug, branch), approvals);
          mergedCache.set(ciKey(repo.slug, branch), merged);
        }

        // Architecture gate. Local git + a cached CODEOWNERS parse, so this runs
        // whether or not the branch has a PR yet; `approvers` only decides
        // needed-vs-approved once one exists.
        const wt = wts.find((x) => x.branch === branch);
        const patterns = archPatterns(repo.dir);
        if (wt && patterns.length) {
          const touched = changedFiles(wt.wtPath).some((f) => patterns.some((re) => re.test(f)));
          if (!touched) archCache.delete(wt.wtPath);
          else {
            const members = architectureMembers();
            const ok = approvers.some((a) => members.has(a.toLowerCase()));
            archCache.set(wt.wtPath, ok ? "approved" : "needed");
          }
        }
      }
    }
    await refreshShortcut();
    slowFetchedAt = Date.now();
  } finally {
    slowInFlight = false;
  }
}

// Pull each sc-<id> branch's workflow state into scTierCache. Runs across ALL repos,
// not just the CircleCI-configured ones, because the story id comes from the branch
// name and has nothing to do with a repo's CI slug.
//
// One request per distinct story per slow tick, and only for branches that actually
// carry an sc- id — with a handful of worktrees that's a few requests per 30s. The
// workflow-state table is fetched once per process on top of that (see
// scStateTiers).
//
// Errors are swallowed per story and the previous cached tier is left alone, so a
// blip leaves the ◆ showing its last known colour instead of flickering to neutral.
async function refreshShortcut(): Promise<void> {
  if (!SHORTCUT_TOKEN) return;

  const ids = new Set<string>();
  for (const repo of REPOS) {
    for (const { branch } of listWorktrees(repo.dir)) {
      const id = shortcutId(branch);
      if (id) ids.add(id);
    }
  }
  if (ids.size === 0) return;

  if (!scStateTiers) {
    try {
      scStateTiers = await loadScStateTiers();
    } catch {
      return; // no state table → can't map anything; try again next tick
    }
  }

  for (const id of ids) {
    try {
      const story = await sc<{ workflow_state_id: number; story_type?: string; description?: string }>(
        `/stories/${id}`
      );
      const tier = scStateTiers.get(story.workflow_state_id);
      if (tier) scTierCache.set(id, tier);
      scStoryCache.set(id, { type: story.story_type ?? "", description: story.description ?? "" });
    } catch {
      /* leave the previous tier in place */
    }
  }
}

// ---- gather (fast, all local) ----

function gather(): Worktree[] {
  const worktrees: Worktree[] = [];
  const live = liveAgentDirs();

  for (const repo of REPOS) {
    const repoLabel = path.basename(repo.dir);
    const wts = listWorktrees(repo.dir);
    if (wts.length === 0) continue;

    // One lookup for every branch in this repo (see pushedBranches). null = couldn't
    // tell, in which case every row stays fully saturated.
    const pushed = pushedBranches(repo.dir, wts.map((w) => w.branch));

    // `git worktree list` always puts the MAIN working tree first (the same
    // guarantee worktree.zsh's clean/rm rely on), so index 0 identifies it without
    // having to guess at branch names — a linked worktree that happens to sit on
    // master is still a real worktree and keeps its full row.
    for (const [i, { wtPath, branch }] of wts.entries()) {
      const isMain = i === 0;
      // A repo with no linked worktrees (popship, term-dash) shouldn't spend a row
      // on its master — there'd be nothing for that row to sit alongside.
      if (isMain && wts.length === 1) continue;
      const agent = newestAgentFor(wtPath);
      // Base state from the transcript, then overlay "waiting" when Cursor's DB
      // shows a live unanswered question. Only worth the DB read when the badge
      // is "running" (open turn + live process) — the one state a pending
      // question can hide inside; done/error/none can't be waiting-on-you.
      let agentState = agentBadge(agent, live.has(path.basename(wtPath)));
      if (agentState === "running" && agent && pendingQuestion(agent.uuid)) {
        agentState = "waiting";
      }
      worktrees.push({
        repo: repoLabel,
        wtPath,
        branch,
        agent,
        isMain,
        mtime: agent?.mtime ?? 0,
        agentState,
        ci: repo.slug ? ciCache.get(ciKey(repo.slug, branch)) ?? { status: "unknown" } : { status: "unknown" },
        // direct PR link (gh-resolved) when we have it; otherwise the head-ref
        // search URL as a graceful fallback until the slow lane fills the cache.
        prUrl: repo.slug
          ? prCache.get(ciKey(repo.slug, branch)) ?? prSearchUrl(repo.slug, branch)
          : undefined,
        hasPr: repo.slug ? prCache.has(ciKey(repo.slug, branch)) : false,
        pushed: pushed ? pushed.has(branch) : true, // null (unknown) → don't desaturate
        scTier: (() => { const id = shortcutId(branch); return id ? scTierCache.get(id) : undefined; })(),
        approvals: repo.slug ? approvalsCache.get(ciKey(repo.slug, branch)) ?? 0 : 0,
        merged: repo.slug ? mergedCache.get(ciKey(repo.slug, branch)) ?? false : false,
        devRunning: false, // resolved below, once all worktrees are known
        arch: archCache.get(wtPath),
      });
    }
  }

  // Flag the worktree serving DEV_PORT. A server's cwd can sit at a worktree
  // root or in a subdir, and one worktree can nest inside another's path, so
  // attribute each cwd to the LONGEST matching worktree path (most specific
  // wins) — that's the one actually running it.
  for (const cwd of devServerDirs()) {
    let best: Worktree | undefined;
    for (const w of worktrees) {
      if (cwd === w.wtPath || cwd.startsWith(w.wtPath + path.sep)) {
        if (!best || w.wtPath.length > best.wtPath.length) best = w;
      }
    }
    if (best) best.devRunning = true;
  }

  // Main-checkout rows are pinned to the TOP, always, and are exempt from MAX_ROWS.
  // Pinned rather than sorted because it's a fixed handle for grabbing that repo's
  // window: it should be in the same place every time you look, not wherever its
  // agent activity happens to put it (popmenu's main checkout has hundreds of
  // sessions, so mtime ordering would shuffle it around), and it should never be
  // truncated away when you have a lot of worktrees open.
  // Below it, linked worktrees split into two sections — ticketed work (see
  // isTicket) then untracked work that has a PR anyway — each keeping the
  // old ordering internally: newest agent activity first, worktrees with no agents
  // sinking to the bottom. The groups are returned CONTIGUOUSLY because render()
  // draws its section rules by watching for the group to change as it walks the
  // list; interleaving them here would emit a rule between every row.
  // Linked worktrees only make the panel when they're real work: see isTrackedWork.
  const main = worktrees.filter((w) => w.isMain);
  const linked = worktrees.filter((w) => !w.isMain && isTrackedWork(w));
  linked.sort((a, b) => b.mtime - a.mtime);

  const ticketed = linked.filter(isTicket);
  const projects = linked.filter((w) => !isTicket(w));
  const [nTicket, nProject] = splitBudget(ticketed.length, projects.length, MAX_ROWS);
  return [...main, ...ticketed.slice(0, nTicket), ...projects.slice(0, nProject)];
}

// A linked worktree earns a row only if it's tied to a ticket or a PR. Prototypes
// and scratch worktrees (help-me-write-prototype, ruby-llm-gem-test, …) pile up and
// crowded out the work that actually has a reviewer or a story waiting on it.
// Three ways in:
//   - the directory is T-prefixed — the naming convention for ticket worktrees,
//     which holds even before the branch is renamed to carry its sc- id
//   - the branch carries an sc-<id>
//   - gh has resolved a PR for the branch. A PR-only worktree therefore appears
//     one slow tick after startup, once refreshSlow has filled prCache.
function isTrackedWork(w: Worktree): boolean {
  return isTicket(w) || !!w.hasPr;
}

function isTicket(w: Worktree): boolean {
  return path.basename(w.wtPath).startsWith("T-") || !!shortcutId(w.branch);
}

// MAX_ROWS is a pane-height budget, and it's now spent across two sections. A flat
// slice would let a busy ticket list push every spike off the bottom — which defeats
// the point of separating them in the first place — so projects are guaranteed up to
// PROJECT_ROW_FLOOR rows whenever they have any, and tickets take the remainder.
const PROJECT_ROW_FLOOR = 3;

function splitBudget(nTicket: number, nProject: number, budget: number): [number, number] {
  if (nTicket + nProject <= budget) return [nTicket, nProject];
  const floor = Math.min(nProject, PROJECT_ROW_FLOOR);
  const takeTicket = Math.max(0, Math.min(nTicket, budget - floor));
  return [takeTicket, Math.min(nProject, Math.max(0, budget - takeTicket))];
}

// ---- render ----

// Which section a row belongs to. The panel groups by KIND of work rather than by
// repo or recency: master is a handle for jumping into the repo, an sc- branch is
// ticketed work with a story and a PR behind it, and anything else is a spike or a
// side project with neither. They want different things from you, so they get
// separated by a rule.
type Section = "main" | "ticket" | "project";

function sectionOf(w: Worktree): Section {
  if (w.isMain) return "main";
  return isTicket(w) ? "ticket" : "project";
}

function ciDot(status: CiStatus): string {
  if (["failed", "failing", "error"].includes(status)) return `${RED}●${RESET}`;
  if (["running", "on_hold"].includes(status)) return `${YELLOW}●${RESET}`;
  if (status === "success") return `${GREEN}●${RESET}`;
  return `${GRAY}●${RESET}`; // canceled, not_run, unauthorized, unknown
}

// Git/PR glyph, sits between the CI dot and the branch name. `⎇` is the
// widely-recognized branch symbol (also the Option-key glyph) and renders in
// plain fonts — no Nerd Font needed. cmd/ctrl-click → the branch's GitHub PR.
// When the PR is MERGED we swap to `↥` (upwards arrow from bar = "merged up into
// base") in GitHub's purple — a single-width, Nerd-Font-free glyph that flags the
// worktree as `worktree clean`-able at a glance. Dim + unlinked when the repo has
// no GitHub slug.
const GIT_GLYPH = "⎇";
const MERGED_GLYPH = "↥";

// "dev server serving from here" marker (after the branch name). `◂` (small
// left-pointing triangle) is single-width and stays text-presentation in plain
// fonts — no Nerd Font / emoji-width surprises.
const DEV_GLYPH = "◂";

// Shortcut ticket glyph, sits right after the ⎇ GH glyph. Shown only when the
// branch carries an `sc-<id>` — the id is the digits right after `sc-`, which
// stop at the next `/` (so steele/sc-170267/foo → 170267). cmd/ctrl-click →
// the Shortcut story. `◆` is single-width and plain-font-safe. The story URL is
// built from the branch alone (no token, no network), so it costs just a regex.
//
// Its COLOUR is the story's pipeline position, filled in on the slow lane (see
// refreshShortcut). Without SHORTCUT_RO_TOKEN, or before the first fetch lands, the
// glyph stays neutral cyan and still links — the colour is an enhancement, never a
// prerequisite.
const SC_GLYPH = "◆";
const SC_SLUG = "popmenu"; // app.shortcut.com/<SC_SLUG>/story/<id>

function shortcutId(branch: string): string | undefined {
  const m = branch.match(/sc-(\d+)/i);
  return m ? m[1] : undefined;
}

function shortcutUrl(branch: string): string | undefined {
  const id = shortcutId(branch);
  return id ? `https://app.shortcut.com/${SC_SLUG}/story/${id}` : undefined;
}

// ◆ colour by pipeline tier:
//   idle   dim     — backlog / planned / ready for dev: not being worked yet
//   active cyan    — in development / ready for review: yours to push on (the
//                    original colour, so the common case looks unchanged)
//   qa     yellow  — ready for QA / in QA: waiting on someone else
//   ship   green   — ready for merge / deploy / approval: go
//   done   purple  — completed, reusing the same hue as the merged-PR ↥
function scColor(tier: ScTier | undefined): string {
  switch (tier) {
    case "idle": return DIM;
    case "qa": return YELLOW;
    case "ship": return GREEN;
    case "done": return PURPLE;
    default: return CYAN; // "active", or unknown/not-yet-fetched
  }
}

// hubdiff (local diff-viewing app) glyph, right after the ◆ Shortcut glyph.
// `±` is the plus/minus of a diff in one cell — single-width, text-presentation
// in plain fonts, and unambiguous next to the other glyphs. Shown on EVERY row:
// hubdiff takes the worktree directory, so it's always available (unlike the PR
// or story links, which need a slug / ticket id) — hence bright white rather
// than a status hue. cmd/ctrl-click → that worktree's diff in hubdiff.
//
// This is the NATIVE Hubdiff.app (Electron, com.colinsteele.hubdiff), not the
// browser copy on hubdiff.localhost: the app registers the `hubdiff:` scheme
// (CFBundleURLTypes) and its `open-url` handler reads ?repo= and repoints the
// single window — same "one surface, repointed per worktree" behavior the tab-
// reuse path gave us, minus the browser. macOS routes the scheme to the running
// instance (or launches it), so there is no port and no tab to keep alive.
const DIFF_GLYPH = "±";
// Scheme + "//" so the path lands in the QUERY, not the URL path: `hubdiff://`
// parses with an empty host, and ?repo= survives percent-decoding intact.
const HUBDIFF_BASE = "hubdiff://";

function hubdiffUrl(wtPath: string): string {
  return `${HUBDIFF_BASE}?repo=${encodeURIComponent(wtPath)}`;
}

// The branch name's cmd-click target: the worktree's Space in Herdr.
//
// Path in the URL's PATH component, not its HOST — hence the split/encode/join
// rather than a flat encodeURIComponent, which would percent-escape the slashes
// and shove the whole path into the host. NSURL LOWERCASES a host, and a
// lowercased /users/colinsteele/code/... no longer string-matches the paths
// `herdr worktree list` reports, even though APFS would still open it.
//
// Handled by HerdrOpen.app → herdr-open.sh, which focuses the existing Space for
// that checkout or creates one. See build-herdr-open-app.sh.
function herdrSpaceUrl(wtPath: string): string {
  return `herdr-space://${wtPath.split("/").map(encodeURIComponent).join("/")}`;
}

// Where the branch name points. Herdr when its handler is installed, Cursor
// otherwise — same reasoning as REUSE_TABS above: a `herdr-space:` link is inert
// on a machine without the .app, so anyone cloning this repo keeps today's
// open-in-Cursor behavior instead of a name that clicks to nothing. Force either
// way with TERMDASH_HERDR_LINKS=1 / =0.
const HERDR_LINKS =
  process.env.TERMDASH_HERDR_LINKS === "1" ||
  (process.env.TERMDASH_HERDR_LINKS !== "0" &&
    fs.existsSync(`${os.homedir()}/Applications/HerdrOpen.app`));

function gitGlyph(prUrl: string | undefined, merged: boolean, pushed: boolean): string {
  // The trailing space lives INSIDE the linked/glyph text so the cmd-click
  // target extends one cell to the right of the glyph — a bare glyph is a
  // one-cell target and reads as "only the left side is clickable". Combined
  // with the literal space before the name in render(), this also yields two
  // spaces of separation between the glyph and the branch name. The unlinked
  // (no-PR) case carries the same trailing space so the name column stays aligned.
  // webLink, so this reuses a tab like every other http link here. prUrl comes in
  // two shapes and the handler keys each on its own: the resolved /pull/<n>, and
  // the /pulls?q=head:<branch> search fallback that a branch with no PR yet keeps
  // forever. Keying them separately is deliberate — once `gh` resolves, the click
  // moves off the stale search tab to the real PR instead of sticking to it.
  if (!prUrl) return `${DIM}${GIT_GLYPH} ${RESET}`;
  // merged is checked BEFORE pushed on purpose: GitHub deletes the head branch on
  // merge, so origin/<branch> is gone and pushed goes false exactly when the row
  // most deserves its purple ↥. Merged wins.
  if (merged) return webLink(`${PURPLE}${MERGED_GLYPH} ${RESET}`, prUrl);
  // Nothing pushed yet, so prUrl here is always the head-ref search fallback and it
  // lands on an empty result list. Still linked (it's a valid place to go once you
  // push, and unlinking would shift the click target), just visibly not-a-PR-yet.
  if (!pushed) return webLink(`${DIM_MAGENTA}${GIT_GLYPH} ${RESET}`, prUrl);
  return webLink(`${MAGENTA}${GIT_GLYPH} ${RESET}`, prUrl);
}

// Fixed-width PR-approval slot, sits between the CI dot and the ⎇ glyph: one
// green ✓ per approval, remaining slots a dim · — so at a glance you see progress
// toward the review bar (e.g. ✓✓ = the two approvals Popmenu needs, ✓· = one
// more to go, ·· = none yet). ALWAYS APPROVALS_NEEDED cells wide regardless of
// count, so it never shifts the branch column or the trailing agent-glyph
// alignment. Static (the ⎇ beside it is what links the PR).
const APPROVALS_NEEDED = 2;

// When the branch is architecture-gated, the LAST cell stops being a generic
// approval and becomes that specific one: yellow `A` outstanding, green `A` once
// a member of @Popmenu/architecture has approved. Yellow because it matches the
// ◆ qa tier — both mean "waiting on somebody who is not you".
//
// It takes a cell rather than adding one on purpose. The slot has to stay
// APPROVALS_NEEDED wide or every row's name column shifts under it, and when
// architecture is on the hook that IS the gating fact — a second generic
// approval does not merge the PR, so showing it instead would be the less true
// of the two. Ungated rows are untouched.
function approvalsSlot(approvals: number, arch: ArchState | undefined): string {
  let out = "";
  const generic = arch ? APPROVALS_NEEDED - 1 : APPROVALS_NEEDED;
  for (let i = 0; i < generic; i++) {
    out += i < approvals ? `${GREEN}✓${RESET}` : `${DIM}·${RESET}`;
  }
  if (arch) {
    out += arch === "approved" ? `${GREEN}${ARCH_GLYPH}${RESET}` : `${BOLD}${YELLOW}${ARCH_GLYPH}${RESET}`;
  }
  return out;
}

// Animated "running" indicator: a track of faint yellow dots with one brighter
// white bead that advances a slot per animation frame, cycling. At
// ANIM_INTERVAL_MS = 500 over RUN_TRACK slots, a full sweep takes ~2s. Direction
// is left→right (flip the `pos` index to reverse) — workshop as needed.
const RUN_TRACK = 4;

function runningGlyph(frame: number): string {
  const pos = frame % RUN_TRACK;
  let out = "";
  for (let i = 0; i < RUN_TRACK; i++) {
    out += i === pos ? `${BOLD}${WHITE}•${RESET}` : `${YELLOW}·${RESET}`;
  }
  return out;
}

// trailing glyph after the name — the Cursor agent's state. Only "running"
// animates (needs the frame counter); the rest are static.
function agentGlyph(state: AgentState, frame: number): string {
  switch (state) {
    case "running":
      return runningGlyph(frame);
    case "waiting":
      // Blocked on a human answer (AskQuestion) — the one state you actually
      // need to act on, so it's a loud static !! rather than an animation.
      // Yellow to match how Cursor itself flags a waiting agent.
      return `${BOLD}${YELLOW}!!${RESET}`;
    case "error":
      return `${RED}✗${RESET}`;
    case "done":
      return `${GREEN}✓${RESET}`;
    default:
      return `${DIM}·${RESET}`;
  }
}

// The agent glyph moved from the right end of the row to the status block on the
// left, and that move is why this exists: the glyphs are 1, 2 and 4 cells wide
// (`·`, `!!`, the 4-slot running track). Trailing, the ragged width cost nothing.
// Leading, it would shift the branch column on every row whose agent state
// differed, so the slot is padded to the widest of them and the glyph centred in
// it — centred rather than flush-left so a lone `·` doesn't hang off the edge of
// its column next to the approvals.
const AGENT_SLOT = RUN_TRACK;

function agentSlotWidth(state: AgentState): number {
  return state === "running" ? RUN_TRACK : state === "waiting" ? 2 : 1;
}

function agentSlot(state: AgentState, frame: number): string {
  const slack = Math.max(0, AGENT_SLOT - agentSlotWidth(state));
  const left = Math.floor(slack / 2);
  return " ".repeat(left) + agentGlyph(state, frame) + " ".repeat(slack - left);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// How much of a branch to show in `width` cells, aiming to FILL the window for
// length parity across rows. Real branches look like
// `owner/sc-162243/human-readable-tail`: the tail distinguishes one worktree
// from another, but the owner/ticket prefix is useful context whenever there's
// room. So keep the longest whole-segment (`/`-delimited) suffix that still fits
// in `width`. A short tail gets its prefix back — `steele/migrate-shortcut`
// (23) instead of a bare `migrate-shortcut` (16) — while a long tail is shown
// alone and handed to displayBranch, which swaps in its cached summary.
// Single-segment branches (master, a bare tail) are returned unchanged.
function fitBranch(branch: string, width: number): string {
  const segs = branch.split("/");
  let out = segs[segs.length - 1]; // always keep the meaningful tail
  for (let i = segs.length - 2; i >= 0; i--) {
    const candidate = segs.slice(i).join("/");
    if (candidate.length > width) break; // adding this segment overflows — stop
    out = candidate;
  }
  return out;
}

// Branch names get a fixed display window; anything longer is shown as its cached
// summary instead (see displayBranch). Capped to the pane width on narrow terminals.
// The subtracted budget is everything that is not the name, and the row is now two
// blocks with the name between them:
//
//   ●  ··A  ·•··      <name>      ⎇ ◆ △ ±
//   status: CI dot,   the work    glyphs: every cmd-click target
//   approvals, agent               (PR, story, sentry, diff)
//
//   1 dot + 1 gap + 2 approvals + 1 gap + 4 agent + 2 gap = 11 left
//   2 gap + 8 glyphs                                      = 10 right
//   + the 2 cells the name block carries for its ◂ dev marker
//
// 23 in total. Change the row in render() and change this, or the name column
// stops being centred and the right-hand glyphs wrap.
const NAME_WIDTH = 36;
function nameWindow(sepWidth: number): number {
  return Math.min(NAME_WIDTH, Math.max(10, sepWidth - 23));
}


// ---- branch summaries: what replaced the marquee ---------------------------
//
// Long branch names used to SCROLL. That meant the pane repainted every 500ms
// forever — `render` clears the whole screen each frame (\x1b[3J\x1b[2J\x1b[H),
// so a single overlong name put the entire panel into a permanent flicker, and
// the panel is on screen all day. The text was also only readable during the
// ~3s it rested at home; the rest of the cycle was motion you had to wait out.
//
// So instead of animating the overflow away, we remove it: an overlong branch is
// shown as a cached 1-2 word summary that FITS. Nothing moves, the fast lane
// stops repainting for names entirely (see animate), and the row is legible at
// every instant rather than one instant in six.
//
// WHERE THE CACHE LIVES. ~/.cache/termdash, beside shortcut-summaries.json and
// sentry-summaries.json, NOT a dotfile inside each worktree. A file in the
// worktree would sit in the repo's working tree — needing a .gitignore entry in
// a shared repo to avoid showing up in everyone's `git status` — and it would be
// deleted by `worktree clean` exactly when the summary is still wanted (the row
// outlives the checkout by one refresh). One file, greppable, survives the
// worktree.
//
// Keyed by the FULL branch name, which is also the source text, so there is no
// separate invalidation field like the other two caches carry: a renamed branch
// is simply a new key. Stale keys are left alone rather than pruned — pruning
// would need to know about every repo this panel has ever scanned, and the file
// is a few hundred bytes.
const CACHE_DIR = path.join(HOME, ".cache", "termdash");
const BRANCH_SUMMARY_CACHE = path.join(CACHE_DIR, "branch-summaries.json");
// Deliberately well under NAME_WIDTH (36). The point is not "fits" but "reads at
// a glance", and 1-2 words is what the eye takes in without scanning.
const BRANCH_SUMMARY_MAX = 24;
const BRANCH_SUMMARY_TIMEOUT_MS = 30_000;
// Same escape hatch as shortcut-peers.ts and morning-brief.ts.
const SUMMARIES_ENABLED = process.env.TERMDASH_NO_LLM !== "1";

interface BranchSummaryEntry {
  summary: string;
  at: string;
  // Which evidence the summary was written from: "sentry" | "pr" | "commits" | "name".
  // Optional so a hand-edited entry stays valid without it.
  from?: string;
  // The Sentry issue this branch fixes, if any. Drives the △ glyph and its link.
  sentry?: SentryRef;
}

function loadBranchSummaries(): Record<string, BranchSummaryEntry> {
  try {
    return JSON.parse(fs.readFileSync(BRANCH_SUMMARY_CACHE, "utf8")) as Record<
      string,
      BranchSummaryEntry
    >;
  } catch {
    return {};
  }
}

let branchSummaries: Record<string, BranchSummaryEntry> = loadBranchSummaries();
let summariesInFlight = false;

// Two branches off the same ticket genuinely can compress to the same words, and
// two identical rows is a worse bug than a long name — you cannot tell which
// worktree you are looking at. The model sees the whole batch at once and usually
// separates them itself; this is the backstop for when it doesn't. Appends the
// first word from the branch tail that the colliding summaries don't share.
function disambiguate(pairs: Map<string, string>): Map<string, string> {
  const bySummary = new Map<string, string[]>();
  for (const [branch, summary] of pairs) {
    const list = bySummary.get(summary) ?? [];
    list.push(branch);
    bySummary.set(summary, list);
  }
  for (const [summary, branches] of bySummary) {
    if (branches.length < 2) continue;
    for (const branch of branches) {
      const have = new Set(summary.split(/\s+/));
      const extra = branch
        .split("/")
        .pop()!
        .split(/[-_.]/)
        .filter((w) => w && !have.has(w.toLowerCase()));
      const tag = extra.length ? extra[extra.length - 1].toLowerCase() : "";
      if (tag) pairs.set(branch, truncate(`${summary} ${tag}`, BRANCH_SUMMARY_MAX));
    }
  }
  return pairs;
}

// What the summary is actually written FROM.
//
// The branch name alone is not enough and this panel has the counter-example
// living in it: two branches off sc-176097 are named
// `…follower-kpi-counts-timeout-for-hampton` and the same again `-social`. The
// names differ by one token and say nothing about what either change DOES. So we
// collect the artifacts that do:
//
//   pr title/body  what the author told reviewers the change does. Highest
//                  signal by a distance — it is a human sentence about the work.
//   commit subjects the same thing in the author's own words before review, and
//                  the only signal at all on a branch with no PR yet.
//   worktree dir   `worktree -b` names the directory after the branch tail, but
//                  a hand-made worktree is often named for the actual task
//                  ("10AF-social-post-fk"), which is a real hint the branch lost.
//   branch name    the fallback, and the thing we are trying to improve on.
interface BranchEvidence {
  branch: string;
  dir: string;
  prTitle?: string;
  prBody?: string;
  commits: string[];
  storyType?: string; // Shortcut story_type — "bug" is a fix, full stop
  sentry?: SentryRef;
}

// origin's default branch, per repo root. `worktree.zsh` resolves it the same
// way and for the same reason: refs/remotes/origin/HEAD is a local pointer
// written at clone time, so reading it costs nothing and needs no network.
function defaultBase(wtPath: string): string {
  try {
    return execFileSync("git", ["-C", wtPath, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim() || "origin/master";
  } catch {
    return "origin/master";
  }
}

// ---- Sentry: is this branch a FIX, and what is it fixing? -----------------
//
// "Add" vs "fix" is not a wording choice, it is a fact about the work, and the
// branch name never carries it — `follower-kpi-counts-timeout-for-hampton` reads
// like a feature and is a production timeout. Two places state it outright:
//
//   1. The WORKTREE DIRECTORY prefix. Sentry-driven worktrees here are named
//      `<sentry short-id suffix>-<slug>`: `10AF-social-post-fk`,
//      `ZY0-follower-kpi-timeout`. This is checked FIRST and wins, because it is
//      per-worktree — the two branches off sc-176097 are two DIFFERENT Sentry
//      issues (10AF and ZY0) and the shared story only names one of them.
//   2. The Shortcut story. A ticket filed from Sentry opens with a literal
//      `Sentry Issue: [SHORT-ID](url)` line, and its story_type is `bug`.
//
// Path 1 needs a guard, because a directory prefix is just a directory prefix:
// `p4-defer-…` and `AIM-2.0-Planning` would otherwise be looked up as short ids.
// Requiring 3-6 uppercase alphanumerics WITH at least one digit rejects `AIM`,
// `P4` and `LLM` before any request, and the API rejects the rest — all three of
// those return 404 when tried, which is the belt to this braces.
interface SentryRef {
  shortId: string;
  title: string;
  culprit?: string;
  url: string;
}

const sentryRefCache = new Map<string, SentryRef | null>(); // short id → ref (null = looked up, absent)

// The suffix a worktree directory is named after, or undefined if the prefix does
// not look like one. Uppercased so `10af-…` still matches.
function sentrySuffixFromDir(dir: string): string | undefined {
  const m = dir.match(/^([A-Za-z0-9]{3,6})-/);
  if (!m) return undefined;
  const suffix = m[1].toUpperCase();
  return /\d/.test(suffix) && /^[A-Z0-9]+$/.test(suffix) ? suffix : undefined;
}

async function sentryLookup(shortId: string): Promise<SentryRef | null> {
  if (sentryRefCache.has(shortId)) return sentryRefCache.get(shortId)!;
  let ref: SentryRef | null = null;
  if (SENTRY_TOKEN) {
    try {
      const res = await fetch(`${SENTRY_API}/organizations/${SENTRY_ORG}/shortids/${shortId}/`, {
        headers: { Authorization: `Bearer ${SENTRY_TOKEN}` },
      });
      if (res.ok) {
        const d = (await res.json()) as { shortId?: string; group?: { title?: string; culprit?: string; permalink?: string } };
        const g = d.group ?? {};
        if (g.title) {
          ref = {
            shortId: d.shortId ?? shortId,
            title: g.title,
            culprit: g.culprit,
            url: g.permalink ?? `https://${SENTRY_ORG}.sentry.io/issues/?query=${encodeURIComponent(shortId)}`,
          };
        }
      }
    } catch {
      /* network blip — cache nothing so the next attempt retries */
      return null;
    }
  }
  sentryRefCache.set(shortId, ref);
  return ref;
}

// Try the directory prefix against each project, then fall back to whatever the
// Shortcut story names. Returns undefined when the branch has no Sentry issue,
// which is the common case and must stay free of network calls — hence the
// suffix guard running before anything is fetched.
async function resolveSentry(w: Worktree): Promise<SentryRef | undefined> {
  const suffix = sentrySuffixFromDir(path.basename(w.wtPath));
  if (suffix) {
    for (const prefix of SENTRY_PROJECT_PREFIXES) {
      const ref = await sentryLookup(`${prefix}-${suffix}`);
      if (ref) return ref;
    }
  }
  const id = shortcutId(w.branch);
  const desc = id ? scStoryCache.get(id)?.description : undefined;
  const m = desc?.match(/Sentry Issue:\s*\[([A-Z0-9-]+)\]\((https?:\/\/[^)\s]+)\)/i);
  if (m) {
    const ref = await sentryLookup(m[1].toUpperCase());
    // Even if the lookup fails (token missing, issue deleted) the story told us
    // the id and the url, which is enough for the glyph and its link.
    return ref ?? { shortId: m[1].toUpperCase(), title: "", url: m[2] };
  }
  return undefined;
}

// ---- architecture review ---------------------------------------------------

type ArchState = "needed" | "approved";

function escapeRe(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One CODEOWNERS pattern -> a RegExp over repo-relative paths. gitignore-ish
// semantics, and only the subset this file actually uses:
//   leading /            anchor to the repo root
//   a / anywhere else    also anchors (CODEOWNERS treats `config/x` as rooted)
//   no / at all          match the basename at any depth (`.snyk`, `knip.js`)
//   trailing /           a directory: everything beneath it
//   *                    one path segment's worth of anything
function codeownersRegex(pattern: string): RegExp {
  let p = pattern.trim();
  const anchored = p.startsWith("/") || p.replace(/\/$/, "").includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  const isDir = p.endsWith("/");
  if (isDir) p = p.replace(/\/$/, "");
  const body = p
    .split("/")
    .map((seg) => seg.split("*").map(escapeRe).join("[^/]*"))
    .join("/");
  return new RegExp(`${anchored ? "^" : "(^|/)"}${body}${isDir ? "/.*" : "(/.*)?"}$`);
}

// Parsed once per process per repo. CODEOWNERS changes about as often as the
// team does, and a stale read costs one wrong glyph until the panel restarts.
const archPatternCache = new Map<string, RegExp[]>();

function archPatterns(repoDir: string): RegExp[] {
  const hit = archPatternCache.get(repoDir);
  if (hit) return hit;
  let out: RegExp[] = [];
  try {
    out = fs
      .readFileSync(path.join(repoDir, ".github", "CODEOWNERS"), "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter((l) => l && l.includes(ARCH_TEAM))
      .map((l) => codeownersRegex(l.split(/\s+/)[0]))
      .filter(Boolean);
  } catch {
    /* no CODEOWNERS in this repo — nothing is architecture-gated */
  }
  archPatternCache.set(repoDir, out);
  return out;
}

// COMMITTED changes only — `<base>...HEAD`, not the working tree.
//
// The first version unioned in `git diff --name-only HEAD` on the theory that a
// migration you have written but not committed already needs the review. In this
// repo that is wrong, and measurably so: a bare `rails db:migrate` rewrites
// `db/schema.rb` as a side effect (the mirror-schema churn `pm-schema-reconcile`
// exists to undo), so three of five worktrees had a dirty schema.rb, none of them
// had committed it, and every one of them lit the marker. A gate that fires on
// almost every row is not a gate.
//
// Committed-only also matches what the marker MEANS. The question is "will this
// PR need architecture approval", and an uncommitted file is not in the PR — nor
// can anyone review it.
function changedFiles(wtPath: string): string[] {
  try {
    return execFileSync("git", ["-C", wtPath, "diff", "--name-only", `${defaultBase(wtPath)}...HEAD`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return []; // missing base ref or a worktree mid-removal
  }
}

// Members of @Popmenu/architecture, resolved once per process. Used only to tell
// "still needed" from "already approved" — without it every gated row would read
// as outstanding forever, which is worse than not marking it at all.
let archMembers: Set<string> | null = null;

function architectureMembers(): Set<string> {
  if (archMembers) return archMembers;
  archMembers = new Set();
  try {
    const out = execFileSync("gh", ["api", `/orgs/${ARCH_TEAM_API}/members`, "--jq", ".[].login"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
    });
    for (const l of out.split("\n")) if (l.trim()) archMembers.add(l.trim().toLowerCase());
  } catch {
    /* no org read scope — everything gated stays "needed", which is the safe read */
  }
  return archMembers;
}

// Worktree -> "owner/repo", via the REPOS entry it was scanned from. Worktree.repo
// is the basename of that dir, which is the join.
function githubRepoFor(w: Worktree): string | null {
  const entry = REPOS.find((r) => path.basename(r.dir) === w.repo);
  return entry?.slug ? githubRepo(entry.slug) : null;
}

// Every non-main branch wants a summary now, not just the ones that overflow, so
// "needs one" is simply "hasn't got one".
function needsSummary(worktrees: Worktree[]): boolean {
  return worktrees.some((w) => !w.isMain && !branchSummaries[w.branch]);
}

async function collectEvidence(w: Worktree): Promise<BranchEvidence> {
  const ev: BranchEvidence = { branch: w.branch, dir: path.basename(w.wtPath), commits: [] };

  try {
    ev.commits = execFileSync(
      "git",
      ["-C", w.wtPath, "log", "--format=%s", "-n", "6", `${defaultBase(w.wtPath)}..HEAD`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }
    )
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    /* detached, missing base ref, or a worktree that just vanished */
  }

  // Only where a PR can exist. An unpushed branch has none by definition, and
  // this saves a ~700ms `gh` round-trip per spike worktree.
  const ghRepo = githubRepoFor(w);
  if (w.pushed && ghRepo) {
    try {
      const out = execFileSync(
        "gh",
        ["pr", "list", "--repo", ghRepo, "--head", w.branch, "--state", "all",
         "--json", "title,body", "--limit", "1", "--jq", '.[0] // empty'],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }
      ).trim();
      if (out) {
        const o = JSON.parse(out) as { title?: string; body?: string };
        ev.prTitle = o.title?.trim() || undefined;
        // First few lines only. A Popmenu PR body carries a template, a test
        // plan and screenshots; the description is at the top and the rest is
        // noise that would dominate the prompt.
        ev.prBody = o.body?.split("\n").slice(0, 6).join(" ").trim().slice(0, 400) || undefined;
      }
    } catch {
      /* gh missing, unauthed, or rate-limited — the other evidence still stands */
    }
  }
  const id = shortcutId(w.branch);
  ev.storyType = id ? scStoryCache.get(id)?.type : undefined;
  ev.sentry = await resolveSentry(w);
  return ev;
}

function renderEvidence(ev: BranchEvidence): string {
  const lines = [`BRANCH: ${ev.branch}`, `  worktree dir: ${ev.dir}`];
  // Sentry first: it is the single most decisive line in the block, because it
  // settles "fix or feature" before the model reads anything else.
  if (ev.sentry) {
    lines.push(`  SENTRY ISSUE ${ev.sentry.shortId} — THIS BRANCH IS A BUG FIX`);
    if (ev.sentry.title) lines.push(`    error: ${ev.sentry.title.slice(0, 200)}`);
    if (ev.sentry.culprit) lines.push(`    culprit: ${ev.sentry.culprit}`);
  }
  if (ev.storyType) lines.push(`  shortcut story type: ${ev.storyType}`);
  if (ev.prTitle) lines.push(`  pr title: ${ev.prTitle}`);
  if (ev.prBody) lines.push(`  pr description: ${ev.prBody}`);
  for (const c of ev.commits) lines.push(`  commit: ${c}`);
  if (!ev.prTitle && !ev.commits.length) lines.push(`  (no PR and no commits yet — name and dir only)`);
  return lines.join("\n");
}

// Ask `claude` for a 1-2 word ACTION summary of each branch. Returns true when it
// wrote something new, so the caller knows to repaint.
//
// One batch, all branches: cheaper than N calls, and it is what lets the model
// tell two near-identical branches apart in the first place.
async function ensureBranchSummaries(worktrees: Worktree[]): Promise<boolean> {
  const missing = worktrees.filter((w) => !w.isMain && !branchSummaries[w.branch]);
  if (!missing.length || !SUMMARIES_ENABLED) return false;

  const evidence = await Promise.all(missing.map(collectEvidence));

  const prompt = [
    `Summarise what each git branch DOES, in 1-2 words.`,
    ``,
    `This is for a status panel where the summary REPLACES the branch name, so it`,
    `has to say what the change does, not what area it touches.`,
    ``,
    `Rules:`,
    `- 1-2 words. Hard limit ${BRANCH_SUMMARY_MAX} characters.`,
    `- ACTION FIRST. Lead with the verb describing the change: "fix social posts",`,
    `  "optimize kpi counts", "defer slack alert". NOT "social posts", NOT`,
    `  "kpi counts" — a bare noun does not distinguish adding a thing from`,
    `  deleting it.`,
    `- A branch with a SENTRY ISSUE, or a Shortcut story type of "bug", is a FIX.`,
    `  Start it with "fix" and name what is broken, taken from the Sentry error`,
    `  and culprit. This OVERRIDES the PR title: a PR called "Add Follower Counts`,
    `  to KPI Metrics" that carries a Sentry timeout is "fix kpi timeout", because`,
    `  the adding is how the fix was done, not what the branch is for.`,
    `- Weight the evidence: the PR title and description say what the change does`,
    `  and are the best source. Commit subjects come next. The worktree directory`,
    `  name is a hint about intent. The BRANCH NAME IS THE WEAKEST SIGNAL — it is`,
    `  often stale, copied from a sibling branch, or names the ticket rather than`,
    `  the work. Do not just re-word the branch name if better evidence exists.`,
    `- Drop the owner prefix (steele/), the ticket id (sc-176097), and filler:`,
    `  wip, p1, p2, p4.`,
    `- If two branches would summarise the same, keep whatever token tells them`,
    `  apart, even if that costs a third word.`,
    `- Lower case, single spaces. No trailing period, no quotes, no emoji.`,
    ``,
    `Return ONLY a JSON object mapping the FULL branch name to its summary, no`,
    `prose and no code fence.`,
    ``,
    ...evidence.map(renderEvidence),
  ].join("\n");

  let raw: string;
  try {
    // cwd is a temp dir on purpose: run from this repo and the CLI loads the
    // project's settings and skills, which costs startup time and context for a
    // task that needs neither. (Lifted from shortcut-peers.ts, which lifted it
    // from morning-brief.ts.)
    raw = execFileSync("claude", ["-p", prompt], {
      encoding: "utf8",
      timeout: BRANCH_SUMMARY_TIMEOUT_MS,
      cwd: os.tmpdir(),
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return false; // claude missing, unauthenticated or slow — names show instead
  }

  let parsed: Record<string, string>;
  try {
    const m = raw.match(/\{[\s\S]*\}/); // tolerate a stray fence or preamble
    parsed = m ? (JSON.parse(m[0]) as Record<string, string>) : {};
  } catch {
    return false;
  }

  const fresh = new Map<string, string>();
  for (const w of missing) {
    const v = (parsed[w.branch] ?? "").trim().toLowerCase();
    if (v) fresh.set(w.branch, truncate(v, BRANCH_SUMMARY_MAX));
  }
  if (!fresh.size) return false;
  disambiguate(fresh);

  const now = new Date().toISOString();
  for (const [branch, summary] of fresh) {
    const ev = evidence.find((e) => e.branch === branch);
    branchSummaries[branch] = {
      summary,
      at: now,
      // What it was written from, so a summary that reads wrong can be traced to
      // thin evidence rather than to the model. Also what tells you a re-run
      // would help: a "name" row gets better the moment a PR exists.
      from: ev?.sentry ? "sentry" : ev?.prTitle ? "pr" : ev?.commits.length ? "commits" : "name",
      // Persisted so the △ and its link survive a restart. The glyph would
      // otherwise vanish until the next slow tick re-resolved it, and a glyph
      // that blinks in and out reads as a bug.
      sentry: ev?.sentry,
    };
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(BRANCH_SUMMARY_CACHE, JSON.stringify(branchSummaries, null, 2));
  } catch {
    /* a cache we could not write just means we regenerate next time */
  }
  return true;
}

// What actually goes in the name column: the summary, always, for every branch
// that has one. NOT a fit-based fallback — a panel where some rows say what the
// work does and others carry a raw branch name reads as two different columns,
// and the raw name is the thing the summary exists to improve on even when it
// happens to fit.
//
// The main checkout is exempt: "master" is not a unit of work and there is
// nothing to summarise. Everything else falls back to the fitted branch name
// while its summary is still being written, and forever under TERMDASH_NO_LLM=1.
function displayBranch(w: Worktree, width: number): string {
  const summary = w.isMain ? undefined : branchSummaries[w.branch]?.summary;
  return truncate(summary ?? fitBranch(w.branch, width), width);
}

function render(worktrees: Worktree[], err: Error | null, frame: number): void {
  process.stdout.write("\x1b[3J\x1b[2J\x1b[H"); // clear scrollback + screen + home

  // No header at all — no title, no leading rule. The pane is identified by its
  // position in the layout and by what is in it, and in a pane this short the
  // most expensive chrome on screen is the row that carries no worktree. The
  // section rules below are the only structure the list needs.
  const sepWidth = process.stdout.columns || 24;
  if (!CIRCLECI_TOKEN) {
    console.log(`${YELLOW}⚠ no CIRCLE_CI_TOKEN — CI dots stay gray${RESET}`);
  }

  if (err) {
    console.log(`${RED}Error:${RESET} ${err.message}`);
    return;
  }
  if (worktrees.length === 0) {
    console.log(`${DIM}No worktrees found.${RESET}`);
    return;
  }

  // Layout:  <ci-dot> <approvals> <git-glyph> <sc-glyph> <diff-glyph> <branch> <dev-marker> <agent-glyph>
  // ci-dot + approvals + git/sc/diff glyphs eat ~11 cols, the animated agent glyph
  // is up to RUN_TRACK dots + spacing (~6), count/note wrap after — leave room so a
  // long branch truncates instead of wrapping.
  const branchMax = Math.max(10, sepWidth - 17);
  const nameW = nameWindow(sepWidth);

  // Section rules are drawn only BETWEEN sections, never leading or trailing:
  // with no header above and no footer below, a bracketing rule would be a row
  // spent on nothing. No section labels either — the rule alone carries the split,
  // and three headings would eat a pane that is mostly rows. Relies on gather()
  // returning each group contiguously.
  let prevSection: Section | null = null;

  for (const w of worktrees) {
    const section = sectionOf(w);
    if (prevSection !== null && section !== prevSection) {
      console.log(DIM + "─".repeat(sepWidth) + RESET);
    }
    prevSection = section;

    // Fit the branch to the window (restoring prefix context when it fits), and
    // fall back to its cached 1-2 word summary when the tail still overflows.
    // NOT padded here — we pad after the dev marker (below) so the marker hugs
    // the name's right edge instead of floating out at the fixed column.
    const nameText = displayBranch(w, nameW);
    const dim = w.agentState === "none";
    const styled = dim ? `${GRAY}${nameText}${RESET}` : `${BOLD}${nameText}${RESET}`;
    // Cmd-click the branch name → that worktree's Space in Herdr, which is where
    // the work actually happens. Falls back to Cursor where HerdrOpen.app isn't
    // installed (see HERDR_LINKS).
    //
    // On the Cursor fallback, ?windowId=_blank forces a NEW window on this
    // worktree. Without it, cursor://file/<folder> routes to the last-focused
    // window of the same repo — so clicking a closed worktree would try to switch
    // THAT window's branch (prompting "confirm switch") instead of opening this
    // one. As a bonus, the fresh window restores that worktree's saved agent chat.
    const nameLink = link(
      styled,
      HERDR_LINKS ? herdrSpaceUrl(w.wtPath) : `cursor://file/${w.wtPath}?windowId=_blank`,
    );

    // CI dot links to the workflow if we have a URL; otherwise it's a plain dot.
    const dot = w.ci.url ? webLink(ciDot(w.ci.status), w.ci.url) : ciDot(w.ci.status);

    // The main-checkout row keeps ONLY the CI dot, the name link and the agent/dev
    // markers. Everything else is a per-branch-of-work signal that master has no
    // answer for — there's no PR to approve, no story behind it, and its "diff" is
    // the baseline everything else diffs against. Each exemption still emits its
    // column's exact width in spaces, so master lines up with the rows above it
    // instead of shifting the whole name column.
    const bare = w.isMain;

    // PR-approval progress (✓✓ / ✓· / ··), fixed width, between the dot and glyph.
    const approvals = bare ? " ".repeat(APPROVALS_NEEDED) : approvalsSlot(w.approvals, w.arch);

    // git glyph between the approvals and the name → the branch's GitHub PR.
    // Blank on master: the only link we could offer is a head:master PR search,
    // which is guaranteed empty and reads as a broken link.
    const git = bare ? "  " : gitGlyph(w.prUrl, w.merged, w.pushed);

    // Shortcut ticket glyph, right after the GH glyph → the branch's story.
    // Fixed 2 cells (blank when the branch has no sc- id) so the name column
    // stays aligned across rows. The trailing space rides inside the link (like
    // gitGlyph) so the cmd-click target extends one cell past the glyph.
    const scUrl = bare ? undefined : shortcutUrl(w.branch);
    const sc = scUrl ? webLink(`${scColor(w.scTier)}${SC_GLYPH} ${RESET}`, scUrl) : "  ";

    // Sentry glyph, right of the story glyph → the production error this branch
    // fixes. Present only on branches that HAVE one, which is what makes it worth
    // a column: it separates "this is a fix" from "this is a feature" at a glance,
    // and the summary beside it already says so in words.
    //
    // Read from the branch-summaries cache rather than resolved per frame — the
    // lookup is a network call, and the row must draw at 5s intervals whether or
    // not Sentry is reachable. Same trailing-space-inside-the-link trick as the
    // glyphs above, so the cmd-click target is 2 cells wide.
    const sentryRef = bare ? undefined : branchSummaries[w.branch]?.sentry;
    const sentry = sentryRef
      ? webLink(`${SENTRY_VIOLET}${SENTRY_GLYPH} ${RESET}`, sentryRef.url)
      : "  ";

    // hubdiff glyph → this worktree's diff. Same trailing-space-inside-the-link
    // trick as the glyphs above, so the click target is 2 cells wide. Blank on
    // master — it's the baseline the other rows diff against, so "its diff" is empty
    // by definition.
    //
    // `link`, NOT `webLink`: webLink exists to route http links through the
    // `termdash:` tab-reuse handler, and a `hubdiff:` URL must reach macOS
    // LaunchServices raw so the native app gets it. Wrapping it would hand the
    // diff back to Chrome — the exact thing this link is here to avoid.
    const diff = bare ? "  " : link(`${WHITE}${DIFF_GLYPH} ${RESET}`, hubdiffUrl(w.wtPath));

    // No "×N" session counter: a row is one agent — the newest session for that
    // worktree (see newestAgentFor). The count inflated the row for no decision it
    // helped you make, and the badge beside it mixed states from separate runs.
    // The error note (e.g. "out of usage") is likewise not rendered: it always
    // wrapped and broke the narrow pane. The ✗ agent glyph already signals "there
    // was an issue" — cmd-click the branch to see the detail.

    // Blue ◂ = "this worktree is serving DEV_PORT", anchored one space off the
    // branch name's right edge, so it travels WITH the name rather than sitting at
    // a fixed column.
    const dev = w.devRunning ? ` ${BLUE}${DEV_GLYPH}${RESET}` : "";
    const devWidth = w.devRunning ? 2 : 0; // " ◂"

    // The name (plus its dev marker) is CENTERED in the name column: split the
    // leftover cells either side instead of dumping them all after the name. The
    // total is still exactly nameW + 2, which is what keeps the trailing agent glyph
    // in one column across every row — only where the slack sits changes.
    // Odd slack gives the extra cell to the RIGHT, so a name sits one cell left of
    // true centre rather than drifting into the agent glyph.
    // A name that had to be truncated fills the window exactly, so it has no slack
    // to split and is unaffected; this is really about the short ones (master) and
    // the summaries, which are deliberately well short of the window.
    const slack = Math.max(0, nameW + 2 - nameText.length - devWidth);
    const padL = " ".repeat(Math.floor(slack / 2));
    const padR = " ".repeat(slack - Math.floor(slack / 2));

    // STATUS on the left, GLYPHS on the right, name between them. The split is
    // by what the cell is FOR, not by what it looks like: everything left of the
    // name is a state you read, everything right of it is a cmd-click target you
    // act on. Previously the two were interleaved (dot, approvals, then the four
    // link glyphs, then the name, then the agent), so the eye had to sort them
    // apart on every row.
    console.log(`${dot} ${approvals} ${agentSlot(w.agentState, frame)}  ${padL}${nameLink}${dev}${padR}  ${git}${sc}${sentry}${diff}`);

    // Under a failing branch, list each failed job indented, hyperlinked to its
    // own CircleCI job page (the dot links the workflow; these drill to the job).
    // Skipped on master: a red master is somebody's whole-team problem, not a
    // this-worktree to-do, and the indents are exactly the panel-inflating noise
    // this row is meant to avoid. The ● dot still carries the status and still
    // cmd-clicks through to the workflow.
    if (bare) continue;
    for (const job of w.ci.failedJobs ?? []) {
      const label = truncate(job.name, Math.max(6, branchMax - 2));
      console.log(`  ${DIM}⎿${RESET} ${webLink(`${RED}${label}${RESET}`, job.url)}`);
    }
  }

  // No CI/Agents tally footer. Both counts restated what the rows already show —
  // every ● dot and every agent glyph is on screen directly above — and they cost
  // three rows (the two tallies plus the rule dividing them from the rows) in a
  // pane whose whole constraint is vertical space. The closing rule went with
  // them: a separator with nothing beneath it is just a spent row.
}

// Latest gathered worktrees + the animation frame, shared between the data loop
// (re-gathers) and the animation loop (re-renders the same data with a new frame).
let lastWorktrees: Worktree[] = [];
let animFrame = 0;

function loop(): void {
  // Slow lane: kick a CI + PR refresh when the cache is stale, then re-render
  // once it lands. Fire-and-forget so the network read never blocks the fast
  // agent tick. Runs even without CIRCLECI_TOKEN — PR resolution (gh) still wants it.
  if (!slowInFlight && Date.now() - slowFetchedAt >= CI_REFRESH_SECONDS * 1000) {
    refreshSlow()
      .then(() => {
        lastWorktrees = gather();
        render(lastWorktrees, null, animFrame);
      })
      .catch(() => {});
  }

  // Fast lane: agents are local, so re-gather + re-render every AGENT_REFRESH_SECONDS.
  try {
    lastWorktrees = gather();
    render(lastWorktrees, null, animFrame);
  } catch (e) {
    render([], e as Error, animFrame);
  }

  // Summary lane: fire-and-forget, exactly like the slow lane above. A new
  // worktree shows its name truncated for one `claude` round-trip and then
  // settles into its summary — the panel never blocks on this, and a failure
  // costs a truncated name rather than a frame.
  //
  // Driven from the poll rather than from a hook in `worktree` creation on
  // purpose: worktrees also arrive by `git worktree add`, by a teammate's
  // script, or from Herdr's own new-worktree flow, and a create-time hook sees
  // none of those. Polling for missing keys catches every path for free.
  if (!summariesInFlight) {
    if (needsSummary(lastWorktrees)) {
      summariesInFlight = true;
      ensureBranchSummaries(lastWorktrees)
        .then((wrote) => {
          if (wrote) render(lastWorktrees, null, animFrame);
        })
        .catch(() => {})
        .finally(() => {
          summariesInFlight = false;
        });
    }
  }

  setTimeout(loop, AGENT_REFRESH_SECONDS * 1000);
}

// Animation lane: advance the running-glyph frame on a fast tick. Re-renders
// from the cached data (no re-gather) and only when something is actually
// running, so an idle panel doesn't flicker between data ticks.
function animate(): void {
  animFrame++;
  // Re-render on the fast tick ONLY when a running glyph needs to advance. Branch
  // names used to force this too, because a long one marqueed — which meant one
  // overlong name repainted the whole panel twice a second for as long as it
  // existed. Summaries are static, so a panel with no running agent now draws
  // exactly once per data tick and holds still.
  if (lastWorktrees.some((w) => w.agentState === "running")) {
    render(lastWorktrees, null, animFrame);
  }
  setTimeout(animate, ANIM_INTERVAL_MS);
}

// ---- entry ----

// `--summarize` fills the cache for every branch that hasn't got a summary,
// prints the result with the evidence each one was written from, and exits
// without starting the panel. The one-shot form of the summary lane in loop().
// `--force` re-summarises branches that already have an entry — what you run
// after a PR lands on a branch that previously had only its name to go on.
if (process.argv.includes("--summarize")) {
  void (async () => {
    const width = nameWindow(Number(process.env.COLUMNS) || process.stdout.columns || 54);
    const worktrees = gather();
    if (process.argv.includes("--force")) {
      for (const w of worktrees) delete branchSummaries[w.branch];
    }
    const pending = worktrees.filter((w) => !w.isMain && !branchSummaries[w.branch]);
    console.log(`name column is ${width} cols; summarising ${pending.length} branch(es)\n`);
    if (pending.length) await ensureBranchSummaries(worktrees);

    for (const w of worktrees) {
      const shown = displayBranch(w, width);
      // `from` says which evidence won, which is the difference between "this
      // summary is wrong" and "this branch has nothing to summarise yet".
      const entry = w.isMain ? undefined : branchSummaries[w.branch];
      const from = w.isMain ? "main" : (entry?.from ?? "none");
      const sid = entry?.sentry ? `${SENTRY_GLYPH} ${entry.sentry.shortId}` : "";
      console.log(`  ${shown.padEnd(width)}  ${from.padEnd(8)} ${sid.padEnd(24)} ${DIM}${w.branch}${RESET}`);
    }
    console.log(`\ncache: ${BRANCH_SUMMARY_CACHE}`);
  })();
} else if (process.argv.includes("--mock")) {
  const t = Date.now();
  render(
    [
      // Ordered the way gather() now returns rows — main, then ticketed (sc-<id>),
      // then spikes/projects — so --mock previews the section rules honestly. Rows
      // interleaved across sections would draw a rule between nearly every line.
      //
      // main checkout: CI dot + name only, pinned first (see gather/render `isMain`).
      { repo: "popmenu", wtPath: "/popmenu", branch: "master", agent: { uuid: "z", mtime: t - 60_000, state: "done", closed: true }, isMain: true, mtime: t - 60_000, agentState: "done", ci: { status: "failed", url: "https://ci-master" }, prUrl: "https://github.com/Popmenu/popmenu/pulls?q=head%3Amaster", approvals: 2, merged: false, pushed: true, devRunning: false },
      // ── ticketed work
      { repo: "popmenu", wtPath: "/y", branch: "steele/sc-170267/list-list-enumerate-clean-up-items-for-text", agent: { uuid: "b", mtime: t - 120_000, state: "done", closed: false }, mtime: t - 120_000, agentState: "waiting", ci: { status: "success", url: "https://y" }, prUrl: "https://github.com/Popmenu/popmenu/pulls?q=is%3Apr+head%3Asteele%2Fsc-170267", approvals: 2, merged: false, pushed: true, isMain: false, devRunning: false },
      { repo: "popmenu", wtPath: "/z", branch: "steele/sc-170112/fix-webhook-retry", agent: { uuid: "d", mtime: t - 480_000, state: "error", closed: true, note: "aborted" }, mtime: t - 480_000, agentState: "error", ci: { status: "failed", url: "https://z" }, prUrl: "https://github.com/Popmenu/popmenu/pulls?q=is%3Apr+head%3Asteele%2Fsc-170112", approvals: 0, merged: false, pushed: true, isMain: false, devRunning: false },
      { repo: "popmenu", wtPath: "/m", branch: "steele/sc-169044/already-merged-cleanup", agent: { uuid: "e", mtime: t - 900_000, state: "done", closed: true }, mtime: t - 900_000, agentState: "done", ci: { status: "success", url: "https://m" }, prUrl: "https://github.com/Popmenu/popmenu/pull/12345", approvals: 2, merged: true, pushed: false, isMain: false, devRunning: false },
      // ── spikes / projects (no sc- id)
      { repo: "popmenu", wtPath: "/x", branch: "steele/migrate-shortcut", agent: { uuid: "a", mtime: t - 5_000, state: "done", closed: false }, mtime: t - 5_000, agentState: "running", ci: { status: "running", url: "https://x" }, prUrl: "https://github.com/Popmenu/popmenu/pulls?q=is%3Apr+head%3Asteele%2Fmigrate-shortcut", approvals: 1, merged: false, pushed: false, isMain: false, devRunning: true },
      { repo: "term-dash", wtPath: "/w", branch: "steele/worktree-panel", mtime: 0, agentState: "none", ci: { status: "unknown" }, approvals: 0, merged: false, pushed: false, isMain: false, devRunning: false },
    ],
    null,
    1 // fixed frame — white bead one slot in, so the animation is visible in a still
  );
} else {
  process.stdout.write(HIDE_CURSOR);
  process.on("exit", () => process.stdout.write(SHOW_CURSOR));
  process.on("SIGINT", () => {
    process.stdout.write(SHOW_CURSOR);
    process.exit(0);
  });
  loop();
  animate();
}
