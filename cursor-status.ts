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
 *        i.e. this worktree is ready to reap with `worktree clean`.
 *   2b. Shortcut ticket       → a cyan ◆ right after the ⎇, shown when the branch
 *        has an sc-<id>. cmd/ctrl-click → the Shortcut story (app.shortcut.com).
 *   3. Cursor agent state     → the trailing glyph after the branch name.
 *        (anim) running · ✓ done · !! waiting on you (a question) · ✗ error ·
 *        (dim) no agent.  cmd/ctrl-click the NAME → focuses that Cursor window.
 *   4. Dev server             → a blue ◂ right after the branch name marks the
 *        worktree whose directory is serving localhost:DEV_PORT (found by
 *        matching the listening process's cwd to the worktree path).
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
 *   export CIRCLECI_TOKEN=...   # optional; without it, CI dots stay gray
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
const AGENTS_PER_WORKTREE = 2; // how many recent sessions to consider per worktree

// Default-branch checkouts aren't interesting agent worktrees — skip them.
const EXCLUDE_BRANCHES = new Set(["master", "main"]);

const CIRCLECI_TOKEN = process.env.CIRCLECI_TOKEN;
const CIRCLECI_API = "https://circleci.com/api/v2";

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
const WHITE = "\x1b[97m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

function link(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
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
  agents: Agent[];
  mtime: number; // most-recent agent activity (0 if none)
  agentState: AgentState; // rolled-up agent badge
  ci: Ci;
  prUrl?: string; // GitHub PR for this branch (undefined = repo has no GitHub slug)
  approvals: number; // # of APPROVED reviews on that PR (0 if none / no PR / not resolved yet)
  merged: boolean; // the branch's most recent PR is MERGED → worktree is `worktree clean`-able
  devRunning: boolean; // a process serving DEV_PORT has its cwd inside this worktree
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
function resolvePr(slug: string, branch: string): { url: string | null; approvals: number; merged: boolean } {
  const repo = githubRepo(slug);
  if (!repo) return { url: null, approvals: 0, merged: false };
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--repo", repo, "--head", branch, "--state", "all",
       "--json", "url,state,latestReviews", "--limit", "1",
       "--jq", '.[0] // empty | {url, merged: (.state == "MERGED"), approvals: ([.latestReviews[] | select(.state=="APPROVED")] | length)}'],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }
    ).trim();
    if (!out) return { url: null, approvals: 0, merged: false };
    const o = JSON.parse(out);
    return { url: o.url ?? null, approvals: o.approvals ?? 0, merged: o.merged ?? false };
  } catch {
    return { url: null, approvals: 0, merged: false };
  }
}

// ---- git worktrees ----

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

function agentsFor(wtPath: string): Agent[] {
  const dir = path.join(HOME, ".cursor", "projects", encodeProject(wtPath), "agent-transcripts");
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return []; // no agent sessions for this worktree
  }
  const agents: Agent[] = [];
  for (const uuid of entries) {
    const a = readAgent(path.join(dir, uuid), uuid);
    if (a) agents.push(a);
  }
  agents.sort((a, b) => b.mtime - a.mtime);
  return agents.slice(0, AGENTS_PER_WORKTREE);
}

// Roll a worktree's agents up to one badge, using the live-process signal.
// error > running > done > none. "running" needs a live agent-exec process (or
// a very recently touched transcript) whose latest turn hasn't closed out.
//
// "waiting" (blocked on your answer to an AskQuestion) is deliberately NOT
// decided here: a pending question is indistinguishable from "running" by the
// transcript alone (see the header note). gather() overlays "waiting" on top of
// a "running" rollup when pendingQuestion() confirms it from Cursor's own state.
function rollupAgent(agents: Agent[], live: boolean): AgentState {
  if (agents.some((a) => a.state === "error")) return "error";
  if (agents.length === 0) return live ? "running" : "none"; // process up, transcript not written yet
  // "running" = a turn that never closed out (no terminal turn_ended), backed by
  // a live agent-exec process for this worktree — or, failing that, a transcript
  // touched in the last few seconds. Checking ANY considered session (not just
  // the newest by mtime) catches a running agent whose own transcript went stale
  // while a sibling session in the same worktree finished more recently.
  const openTurn = agents.some((a) => !a.closed);
  const recentOpen = agents.some((a) => !a.closed && Date.now() - a.mtime < RUNNING_WINDOW_MS);
  if (openTurn && (live || recentOpen)) return "running";
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
let slowFetchedAt = 0;
let slowInFlight = false;

function ciKey(slug: string, branch: string): string {
  return `${slug} ${branch}`;
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
      const branches = new Set(
        listWorktrees(repo.dir)
          .map((w) => w.branch)
          .filter((b) => !EXCLUDE_BRANCHES.has(b))
      );
      if (CIRCLECI_TOKEN) {
        const map = await ciForRepo(repo.slug, branches);
        for (const [branch, ci] of map) ciCache.set(ciKey(repo.slug, branch), ci);
      }
      for (const branch of branches) {
        const { url, approvals, merged } = resolvePr(repo.slug, branch);
        // Only cache on a resolved PR, so a transient gh failure (url:null,
        // approvals:0) never clobbers a previously-known URL, approval count, or
        // merged flag.
        if (url) {
          prCache.set(ciKey(repo.slug, branch), url);
          approvalsCache.set(ciKey(repo.slug, branch), approvals);
          mergedCache.set(ciKey(repo.slug, branch), merged);
        }
      }
    }
    slowFetchedAt = Date.now();
  } finally {
    slowInFlight = false;
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

    for (const { wtPath, branch } of wts) {
      if (EXCLUDE_BRANCHES.has(branch)) continue; // skip the default-branch checkout
      const agents = agentsFor(wtPath);
      // Base state from the transcript, then overlay "waiting" when Cursor's DB
      // shows a live unanswered question. Only worth the DB read when the rollup
      // is "running" (open turn + live process) — the one state a pending
      // question can hide inside; done/error/none can't be waiting-on-you.
      let agentState = rollupAgent(agents, live.has(path.basename(wtPath)));
      if (agentState === "running" && agents.some((a) => pendingQuestion(a.uuid))) {
        agentState = "waiting";
      }
      worktrees.push({
        repo: repoLabel,
        wtPath,
        branch,
        agents,
        mtime: agents[0]?.mtime ?? 0,
        agentState,
        ci: repo.slug ? ciCache.get(ciKey(repo.slug, branch)) ?? { status: "unknown" } : { status: "unknown" },
        // direct PR link (gh-resolved) when we have it; otherwise the head-ref
        // search URL as a graceful fallback until the slow lane fills the cache.
        prUrl: repo.slug
          ? prCache.get(ciKey(repo.slug, branch)) ?? prSearchUrl(repo.slug, branch)
          : undefined,
        approvals: repo.slug ? approvalsCache.get(ciKey(repo.slug, branch)) ?? 0 : 0,
        merged: repo.slug ? mergedCache.get(ciKey(repo.slug, branch)) ?? false : false,
        devRunning: false, // resolved below, once all worktrees are known
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

  // newest agent activity first; worktrees with no agents sink to the bottom
  worktrees.sort((a, b) => b.mtime - a.mtime);
  return worktrees.slice(0, MAX_ROWS);
}

// ---- render ----

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
const SC_GLYPH = "◆";
const SC_SLUG = "popmenu"; // app.shortcut.com/<SC_SLUG>/story/<id>

function shortcutUrl(branch: string): string | undefined {
  const m = branch.match(/sc-(\d+)/i);
  return m ? `https://app.shortcut.com/${SC_SLUG}/story/${m[1]}` : undefined;
}

function gitGlyph(prUrl: string | undefined, merged: boolean): string {
  // The trailing space lives INSIDE the linked/glyph text so the cmd-click
  // target extends one cell to the right of the glyph — a bare glyph is a
  // one-cell target and reads as "only the left side is clickable". Combined
  // with the literal space before the name in render(), this also yields two
  // spaces of separation between the glyph and the branch name. The unlinked
  // (no-PR) case carries the same trailing space so the name column stays aligned.
  if (!prUrl) return `${DIM}${GIT_GLYPH} ${RESET}`;
  if (merged) return link(`${PURPLE}${MERGED_GLYPH} ${RESET}`, prUrl);
  return link(`${MAGENTA}${GIT_GLYPH} ${RESET}`, prUrl);
}

// Fixed-width PR-approval slot, sits between the CI dot and the ⎇ glyph: one
// green ✓ per approval, remaining slots a dim · — so at a glance you see progress
// toward the review bar (e.g. ✓✓ = the two approvals Popmenu needs, ✓· = one
// more to go, ·· = none yet). ALWAYS APPROVALS_NEEDED cells wide regardless of
// count, so it never shifts the branch column or the trailing agent-glyph
// alignment. Static (the ⎇ beside it is what links the PR).
const APPROVALS_NEEDED = 2;

function approvalsSlot(approvals: number): string {
  let out = "";
  for (let i = 0; i < APPROVALS_NEEDED; i++) {
    out += i < approvals ? `${GREEN}✓${RESET}` : `${DIM}·${RESET}`;
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
// alone and left to marquee. Single-segment branches (master, a bare tail) are
// returned unchanged.
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

// Branch names get a fixed display window; anything longer marquees instead of
// truncating (see marquee). Capped to the pane width on narrow terminals.
const NAME_WIDTH = 36;
function nameWindow(sepWidth: number): number {
  return Math.min(NAME_WIDTH, Math.max(10, sepWidth - 15));
}

// Marquee a branch name that overflows the window: show a `width`-char slice
// that advances one char per animation frame, wrapping around with a small gap
// so the tail and head don't visually collide. Names that fit are returned as-is.
function marquee(name: string, width: number, frame: number): string {
  if (name.length <= width) return name;
  const track = name + "   "; // gap before it wraps back to the start
  const off = frame % track.length;
  return (track + track).slice(off, off + width);
}

function render(worktrees: Worktree[], err: Error | null, frame: number): void {
  process.stdout.write("\x1b[3J\x1b[2J\x1b[H"); // clear scrollback + screen + home

  // Header kept to just the title — the "updated / refresh cadence" readout was
  // noise (refresh is silent-and-frequent). The freed space on this line is
  // reserved for something useful later.
  console.log(`${BOLD}Worktrees${RESET}`);
  if (!CIRCLECI_TOKEN) {
    console.log(`${YELLOW}⚠ no CIRCLECI_TOKEN — CI dots stay gray${RESET}`);
  }
  const sepWidth = process.stdout.columns || 24;
  console.log(DIM + "─".repeat(sepWidth) + RESET);

  if (err) {
    console.log(`${RED}Error:${RESET} ${err.message}`);
    return;
  }
  if (worktrees.length === 0) {
    console.log(`${DIM}No worktrees found.${RESET}`);
    return;
  }

  // Layout:  <ci-dot> <approvals> <git-glyph> <sc-glyph> <branch> <dev-marker> <agent-glyph> [×N] [note]
  // ci-dot + approvals + git-glyph eat ~7 cols, the animated agent glyph is up to
  // RUN_TRACK dots + spacing (~6), count/note wrap after — leave room so a long
  // branch truncates instead of wrapping.
  const branchMax = Math.max(10, sepWidth - 15);
  const nameW = nameWindow(sepWidth);

  for (const w of worktrees) {
    // Fit the branch to the window (restoring prefix context when it fits) and
    // marquee it if the tail still overflows. NOT padded here — we pad after the
    // dev marker (below) so the marker hugs the name's right edge instead of
    // floating out at the fixed column.
    const nameText = marquee(fitBranch(w.branch, nameW), nameW, frame);
    const dim = w.agentState === "none";
    const styled = dim ? `${GRAY}${nameText}${RESET}` : `${BOLD}${nameText}${RESET}`;
    // ?windowId=_blank forces Cursor to open a NEW window on this worktree.
    // Without it, cursor://file/<folder> routes to the last-focused window of
    // the same repo — so clicking a closed worktree would try to switch THAT
    // window's branch (prompting "confirm switch") instead of opening this one.
    // As a bonus, the fresh window restores that worktree's saved agent chat.
    const nameLink = link(styled, `cursor://file/${w.wtPath}?windowId=_blank`);

    // CI dot links to the workflow if we have a URL; otherwise it's a plain dot.
    const dot = w.ci.url ? link(ciDot(w.ci.status), w.ci.url) : ciDot(w.ci.status);

    // PR-approval progress (✓✓ / ✓· / ··), fixed width, between the dot and glyph.
    const approvals = approvalsSlot(w.approvals);

    // git glyph between the approvals and the name → the branch's GitHub PR.
    const git = gitGlyph(w.prUrl, w.merged);

    // Shortcut ticket glyph, right after the GH glyph → the branch's story.
    // Fixed 2 cells (blank when the branch has no sc- id) so the name column
    // stays aligned across rows. The trailing space rides inside the link (like
    // gitGlyph) so the cmd-click target extends one cell past the glyph.
    const scUrl = shortcutUrl(w.branch);
    const sc = scUrl ? link(`${CYAN}${SC_GLYPH} ${RESET}`, scUrl) : "  ";

    const count = w.agents.length > 1 ? `${DIM} ×${w.agents.length}${RESET}` : "";
    // The error note (e.g. "out of usage") is intentionally not rendered: it
    // always wrapped and broke the narrow pane. The ✗ agent glyph already
    // signals "there was an issue" — cmd-click the branch to see the detail.

    // Blue ◂ = "this worktree is serving DEV_PORT", anchored one space off the
    // branch name's right edge. Pad AFTER it (filling the rest of the name
    // column) so the trailing agent glyph still lines up across rows whatever the
    // name/marker length. " ◂" is 2 cells; nameW + 2 keeps the agent-glyph column
    // exactly where the old fixed-slot layout put it.
    const dev = w.devRunning ? ` ${BLUE}${DEV_GLYPH}${RESET}` : "";
    const devWidth = w.devRunning ? 2 : 0; // " ◂"
    const pad = " ".repeat(Math.max(0, nameW + 2 - nameText.length - devWidth));

    console.log(`${dot} ${approvals} ${git} ${sc}${nameLink}${dev}${pad} ${agentGlyph(w.agentState, frame)}${count}`);

    // Under a failing branch, list each failed job indented, hyperlinked to its
    // own CircleCI job page (the dot links the workflow; these drill to the job).
    for (const job of w.ci.failedJobs ?? []) {
      const label = truncate(job.name, Math.max(6, branchMax - 2));
      console.log(`  ${DIM}⎿${RESET} ${link(`${RED}${label}${RESET}`, job.url)}`);
    }
  }

  console.log(DIM + "─".repeat(sepWidth) + RESET);

  const ci = (pred: (s: CiStatus) => boolean) => worktrees.filter((w) => pred(w.ci.status)).length;
  const passing = ci((s) => s === "success");
  const ciRun = ci((s) => s === "running" || s === "on_hold");
  const failing = ci(isFailing);
  // "CI" padded to the width of "Agents" so the two summary rows line up.
  console.log(
    `${DIM}CI    ${RESET}  ${GREEN}${passing} pass${RESET}  ${YELLOW}${ciRun} run${RESET}  ${RED}${failing} fail${RESET}`
  );

  const ag = (s: AgentState) => worktrees.filter((w) => w.agentState === s).length;
  // "attn" = a pending question (waiting) — yellow, matching Cursor's own
  // waiting flag and the !! glyph. Broken out from "err" (a failed turn) so a
  // question is unmistakable.
  console.log(
    `${DIM}Agents${RESET}  ${GREEN}${ag("done")} done${RESET}  ${YELLOW}${ag("running")} run${RESET}  ${BOLD}${YELLOW}${ag("waiting")} attn${RESET}  ${RED}${ag("error")} err${RESET}  ${GRAY}${ag("none")} idle${RESET}`
  );
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
  setTimeout(loop, AGENT_REFRESH_SECONDS * 1000);
}

// Animation lane: advance the running-glyph frame on a fast tick. Re-renders
// from the cached data (no re-gather) and only when something is actually
// running, so an idle panel doesn't flicker between data ticks.
function animate(): void {
  animFrame++;
  // Re-render on the fast tick when either the running glyph needs to advance
  // OR a branch name is long enough to marquee — otherwise an idle panel with
  // only short names stays static (no flicker between data ticks).
  const win = nameWindow(process.stdout.columns || 24);
  const running = lastWorktrees.some((w) => w.agentState === "running");
  const scrolling = lastWorktrees.some((w) => fitBranch(w.branch, win).length > win);
  if (running || scrolling) {
    render(lastWorktrees, null, animFrame);
  }
  setTimeout(animate, ANIM_INTERVAL_MS);
}

// ---- entry ----

if (process.argv.includes("--mock")) {
  const t = Date.now();
  render(
    [
      { repo: "popmenu", wtPath: "/x", branch: "steele/migrate-shortcut", agents: [{ uuid: "a", mtime: t - 5_000, state: "done", closed: false }], mtime: t - 5_000, agentState: "running", ci: { status: "running", url: "https://x" }, prUrl: "https://github.com/Popmenu/popmenu/pulls?q=is%3Apr+head%3Asteele%2Fmigrate-shortcut", approvals: 1, merged: false, devRunning: true },
      { repo: "popmenu", wtPath: "/y", branch: "steele/sc-170267/list-list-enumerate-clean-up-items-for-text", agents: [{ uuid: "b", mtime: t - 120_000, state: "done", closed: false }], mtime: t - 120_000, agentState: "waiting", ci: { status: "success", url: "https://y" }, prUrl: "https://github.com/Popmenu/popmenu/pulls?q=is%3Apr+head%3Asteele%2Fsc-170267", approvals: 2, merged: false, devRunning: false },
      { repo: "popmenu", wtPath: "/z", branch: "steele/sc-170112/fix-webhook-retry", agents: [{ uuid: "d", mtime: t - 480_000, state: "error", closed: true, note: "aborted" }], mtime: t - 480_000, agentState: "error", ci: { status: "failed", url: "https://z" }, prUrl: "https://github.com/Popmenu/popmenu/pulls?q=is%3Apr+head%3Asteele%2Fsc-170112", approvals: 0, merged: false, devRunning: false },
      { repo: "popmenu", wtPath: "/m", branch: "steele/sc-169044/already-merged-cleanup", agents: [{ uuid: "e", mtime: t - 900_000, state: "done", closed: true }], mtime: t - 900_000, agentState: "done", ci: { status: "success", url: "https://m" }, prUrl: "https://github.com/Popmenu/popmenu/pull/12345", approvals: 2, merged: true, devRunning: false },
      { repo: "term-dash", wtPath: "/w", branch: "steele/worktree-panel", agents: [], mtime: 0, agentState: "none", ci: { status: "unknown" }, approvals: 0, merged: false, devRunning: false },
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
