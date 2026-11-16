#!/usr/bin/env -S npx tsx
/**
 * herdr-sync — keeps Herdr Spaces 1-1 with a repo's git worktrees, and paints
 * each Space with its branch's CircleCI status.
 *
 * Two jobs, both idempotent, run on one 30s cadence:
 *
 *   1. RECONCILE. `herdr worktree list` already enumerates every git worktree
 *      of the repo and reports `open_workspace_id` for the ones currently open
 *      as Spaces. Any worktree without one gets `herdr worktree open`, labelled
 *      with its directory basename (all Spaces default to the repo name
 *      otherwise, which is useless when there are nine of them). Herdr does not
 *      watch the filesystem, so a worktree created by `git worktree add` or
 *      worktree.zsh only becomes a Space because this loop notices it.
 *
 *   2. PAINT. For every open Space, push CircleCI state as workspace metadata
 *      tokens. Metadata values are plain strings with no colour field, and
 *      config styling is static per token — so one `$ci` token could only ever
 *      be one colour. Instead we declare three tokens and light exactly one:
 *
 *        $ci_fail  red     ● 3 failing
 *        $ci_run   yellow  ⏱ CI
 *        $ci_ok    green   ✓
 *
 *      The other two are cleared each cycle, so a Space never shows a stale
 *      green next to a fresh red.
 *
 * Tokens carry a 90s TTL — three polls. A single missed cycle (network blip)
 * keeps the dot on screen, but if this daemon dies the dots disappear within
 * 90s rather than lying indefinitely. That is what ttl_ms is for; re-asserting
 * state on every cycle is the intended pattern, not an optimisation.
 *
 * The CI half started as a lift from cursor-status.ts (`worstStatus`, the status
 * sets) so both dashboards agree on what "failing" means. Kept as a copy rather
 * than an import because cursor-status.ts is a self-contained script with no
 * module exports, and this daemon has to run without it.
 *
 * It has since diverged in one way that matters: CI is resolved with one
 * `?branch=` query per branch instead of a single `pipeline/mine` call filtered
 * client-side. `mine` caps at ~20 pipelines and only sees ones YOU triggered, so
 * a branch dropped off the dashboard once you'd pushed a few other things, and a
 * teammate's run on a shared branch never counted. cursor-status.ts still has
 * the `mine` behaviour.
 *
 * ── Requires ─────────────────────────────────────────────────────────────────
 *   CIRCLECI_TOKEN   without it, reconcile still runs and CI dots stay absent
 *   a running Herdr server (this talks to it over the CLI's socket API)
 *
 * ── Render config ────────────────────────────────────────────────────────────
 * The tokens are invisible until ~/.config/herdr/config.toml references them.
 * Custom tokens MUST be `$`-prefixed — the config validator rejects a bare name
 * with "custom tokens must start with `$`":
 *
 *   [ui.sidebar.spaces]
 *   rows = [
 *     ["state_icon", "workspace"],
 *     ["branch", "git_status",
 *       { token = "$ci_fail", fg = "#ff6188", bold = true },
 *       { token = "$ci_run",  fg = "#f9e2af" },
 *       { token = "$ci_ok",   fg = "#a6e3a1", dim = true }],
 *   ]
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   ./herdr-sync.ts --dry-run --once   show what it would change, touch nothing
 *   ./herdr-sync.ts --once             one full cycle, then exit
 *   ./herdr-sync.ts                    poll forever (run detached)
 *   ./herdr-sync.ts --no-open          paint CI only; never create a Space
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  buildLinks,
  buildTokens,
  devServerDirs,
  fetchComments,
  githubRepo,
  architecturePatterns,
  needsArchitecture,
  resolvePr,
  shortcutTiers,
  summarizeComments,
  APPROVALS_NEEDED,
  NO_PR,
  type CommentSummary,
  type Pr,
  type ScTier,
  type SpaceSidecar,
} from "./herdr-space-tokens.ts";

// Where the popup menu reads its links from. One file per Space, rewritten on
// every paint, so the menu can never disagree with the glyph strip beside it.
const SIDECAR_DIR = path.join(os.homedir(), ".local/state/herdr/space-links");

// Spaces whose comment tree is folded, keyed by WORKTREE PATH rather than
// workspace id: ids change whenever a Space is recreated (the flatten migration
// changed all nine at once), and a fold you set should outlive that.
const COLLAPSED_PATH = path.join(os.homedir(), ".local/state/herdr/collapsed-spaces.json");

function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(COLLAPSED_PATH, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

// ── merge-ready notifications ───────────────────────────────────────────────
//
// Branches already announced as ready, so the popup fires on the EDGE and not
// once every poll. Keyed by branch and persisted, because the alternative — an
// in-memory Set — re-announces every PR the first cycle after any restart, and
// this daemon restarts whenever launchd reloads it.
//
// A branch is removed once it stops being ready, so a re-freeze followed by
// another thaw announces again. That is the point: the notification tracks the
// transition, not the PR.
const MERGE_READY_PATH = path.join(os.homedir(), ".local/state/herdr/merge-ready.json");

function readMergeReady(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(MERGE_READY_PATH, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

function writeMergeReady(branches: Set<string>): void {
  try {
    fs.mkdirSync(path.dirname(MERGE_READY_PATH), { recursive: true });
    fs.writeFileSync(MERGE_READY_PATH, JSON.stringify([...branches]));
  } catch {
    /* worst case the popup repeats after a restart — not worth failing a cycle */
  }
}

// Every condition GitHub's merge button checks, as far as we can see it from
// here. mergeStateStatus is the freeze-sensitive one: on this repo it sits at
// BLOCKED with green checks and both approvals in, and only goes CLEAN once the
// repo is open for merging again.
function mergeReady(pr: Pr, ci: Ci | undefined): boolean {
  return (
    !pr.merged &&
    !pr.isDraft &&
    pr.number !== null &&
    pr.approvals >= APPROVALS_NEEDED &&
    pr.mergeStateStatus === "CLEAN" &&
    ci?.status === "success"
  );
}

// Fire-and-forget: a popup that fails is not worth losing a paint cycle over.
// --sound done rather than request, which is the "agent wants you" chime.
async function notifyMergeReady(name: string, pr: Pr): Promise<void> {
  try {
    await herdr([
      "notification", "show", "Ready to merge",
      "--body", `#${pr.number} ${name} — approved, CI green, repo open`,
      "--position", "top-right",
      "--sound", "done",
    ]);
    log(`notified: #${pr.number} ${name} is ready to merge`);
  } catch (err) {
    log(`notification failed for ${name}: ${(err as Error).message}`);
  }
}

// ── CI-failure notifications ────────────────────────────────────────────────
//
// Same edge-triggered shape as merge-ready above, and separate state so the two
// cannot mask each other: a branch can be announced failing, get fixed, and be
// announced ready without either file knowing about the other.
//
// Removed from the set once CI stops failing, so a re-break announces again —
// which is the whole point on a branch you are pushing fixes to.
// ── worktrees being removed ─────────────────────────────────────────────────
//
// Tombstones, so this daemon does not helpfully rebuild a Space the user just
// deleted.
//
// prefix+shift+D (space-remove-worktree.zsh) closes the Space first, then runs
// `git worktree remove`, which takes ~17s on popmenu. This loop polls every
// 30s, and in that window it sees a worktree that is still in
// `herdr worktree list` with no Space attached — exactly the condition for
// "create one". So the Space came straight back, and then its directory
// vanished underneath it.
//
// The removal script writes the path here BEFORE it closes anything, so there
// is no window at all, not even a narrow one.
//
// SHORT TTL ON PURPOSE. A tombstone is a lie about the state of the world, and
// the only safe lie is a brief one: if the removal fails, the worktree is real
// and should get its Space back on its own, without anyone remembering to
// clean up a file. Five minutes is comfortably longer than a slow removal plus
// Herdr's own rescan, and short enough that a failure self-heals before you
// have finished wondering about it.
const REMOVING_PATH = path.join(os.homedir(), ".local/state/herdr/removing-worktrees.json");

/** Worktree paths whose tombstone has not expired. Expired entries are simply
 * ignored; the file is rewritten by whoever next adds one. */
function readRemoving(): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(REMOVING_PATH, "utf8")) as Record<string, number>;
    const now = Date.now();
    return new Set(
      Object.entries(raw)
        .filter(([, expiresAt]) => typeof expiresAt === "number" && expiresAt > now)
        .map(([p]) => p),
    );
  } catch {
    return new Set();
  }
}

const CI_FAILED_PATH = path.join(os.homedir(), ".local/state/herdr/ci-failed.json");

function readCiFailed(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(CI_FAILED_PATH, "utf8")) as string[]);
  } catch {
    return new Set();
  }
}

function writeCiFailed(branches: Set<string>): void {
  try {
    fs.mkdirSync(path.dirname(CI_FAILED_PATH), { recursive: true });
    fs.writeFileSync(CI_FAILED_PATH, JSON.stringify([...branches]));
  } catch {
    /* worst case the popup repeats after a restart */
  }
}

// --sound request, not done: this is the "something wants you" chime, whereas
// merge-ready earns the satisfied one.
//
// NOTE ON DURATION: Herdr gives no control over how long a toast stays up.
// `duration_ms` exists inside the binary but is not exposed in config.toml, and
// `notification.show` takes only title/body/position/sound. An ~8s toast is not
// expressible; `[ui.toast] delivery = "system"` hands off to macOS Notification
// Center instead, which persists until dismissed.
async function notifyCiFailed(name: string, pr: Pr, ci: Ci): Promise<void> {
  // Deduped by name: a parallelised job fails once per container, so the first
  // real notification read "cypress_e2e_consumer_tests, cypress_e2e_consumer_tests".
  // The count that matters is distinct jobs, not failed containers.
  const names = [...new Set((ci.failedJobs ?? []).map((j) => j.name))];
  const detail = names.length
    ? names.slice(0, 3).join(", ") + (names.length > 3 ? `, +${names.length - 3} more` : "")
    : "see CircleCI";
  const num = pr.number !== null ? `#${pr.number} ` : "";
  try {
    await herdr([
      "notification", "show", "CI failed",
      "--body", `${num}${name} — ${detail}`,
      "--position", "top-right",
      "--sound", "request",
    ]);
    log(`notified: ${name} CI failed (${detail})`);
  } catch (err) {
    log(`ci-failed notification failed for ${name}: ${(err as Error).message}`);
  }
}

// The toggle script signals us instead of waiting out the poll — a fold that
// takes up to 30s to show is not a toggle. Written where the script can find it
// without pgrep, which would match the npm/tsx wrappers as well as the daemon.
const PID_PATH = path.join(os.homedir(), ".local/state/herdr/herdr-sync.pid");

// Live sidebar width, for right-aligning the tree rows. The server rewrites
// session.json every few seconds, so this tracks the divider as you drag it —
// config.toml only sets the ceiling and is not the current value. Falls back to
// the documented default rather than guessing wide, since padding past the edge
// wraps a row and padding short of it just looks left-ish.
const SESSION_PATH = path.join(os.homedir(), ".config/herdr/session.json");
const DEFAULT_SIDEBAR_WIDTH = 26;

function sidebarWidth(): number {
  try {
    const w = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8")).sidebar_width;
    return typeof w === "number" && w > 0 ? w : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function writePid(): void {
  try {
    fs.mkdirSync(path.dirname(PID_PATH), { recursive: true });
    fs.writeFileSync(PID_PATH, String(process.pid));
  } catch {
    /* the toggle just falls back to waiting for the next cycle */
  }
}

// A closed Space leaves its sidecar behind. Herdr does not reuse workspace ids,
// so a stale file is never read — but they accumulate, and a directory full of
// dead Spaces makes it hard to tell what the menu would actually show.
function pruneSidecars(liveIds: Set<string>): void {
  try {
    for (const f of fs.readdirSync(SIDECAR_DIR)) {
      if (!f.endsWith(".json")) continue;
      if (liveIds.has(f.slice(0, -".json".length))) continue;
      fs.unlinkSync(path.join(SIDECAR_DIR, f));
    }
  } catch {
    /* directory may not exist yet */
  }
}

// A Space renamed by hand has to survive every later cycle. "The user renamed
// this" and "this Space has a stale name" look identical if you only read the
// label, so we track two things per Space: `set`, the last label this daemon
// wrote, and `pinned`, meaning a human has since moved it.
//
// `pinned` has to be its OWN flag. A previous version stored only `set` and
// overwrote it with the user's label on detection — which erased the difference
// it was testing, so the next cycle saw label === set, fell through, and renamed
// anyway. The name held for exactly one cycle. Do not collapse these two fields.
const NAMES_PATH = path.join(os.homedir(), ".local/state/herdr/space-names.json");

interface NameState {
  set: string; // last label this daemon wrote
  pinned: boolean; // a human renamed it; hands off from now on
}

function readNameState(): Record<string, NameState> {
  try {
    const raw = JSON.parse(fs.readFileSync(NAMES_PATH, "utf8")) as Record<string, unknown>;
    const out: Record<string, NameState> = {};
    for (const [id, v] of Object.entries(raw)) {
      // Tolerate the old flat {id: "name"} format.
      if (typeof v === "string") out[id] = { set: v, pinned: false };
      else if (v && typeof v === "object" && typeof (v as NameState).set === "string") {
        out[id] = { set: (v as NameState).set, pinned: Boolean((v as NameState).pinned) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeNameState(state: Record<string, NameState>): void {
  try {
    fs.mkdirSync(path.dirname(NAMES_PATH), { recursive: true });
    fs.writeFileSync(NAMES_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    log(`space-names write failed: ${(err as Error).message}`);
  }
}

function writeSidecar(workspaceId: string, sidecar: SpaceSidecar): void {
  try {
    fs.mkdirSync(SIDECAR_DIR, { recursive: true });
    fs.writeFileSync(path.join(SIDECAR_DIR, `${workspaceId}.json`), JSON.stringify(sidecar, null, 2));
  } catch (err) {
    log(`sidecar write failed for ${workspaceId}: ${(err as Error).message}`);
  }
}

const execFileP = promisify(execFile);
const HOME = os.homedir();

// ── config ──────────────────────────────────────────────────────────────────

const HERDR = path.join(HOME, ".local/bin/herdr");

// Repos to keep in sync. `slug` is the CircleCI project slug (null = no CI
// lookup, reconcile only). Mirrors REPOS in cursor-status.ts.
const REPOS: { dir: string; slug: string | null }[] = [
  { dir: path.join(HOME, "Code/popmenu"), slug: "gh/Popmenu/popmenu" },
];

const POLL_SECONDS = 30; // CI is a network read; matches CI_REFRESH_SECONDS in cursor-status.ts
const CI_CONCURRENCY = 4; // simultaneous per-branch CI requests; keeps us clear of rate limits
const TOKEN_TTL_MS = 90_000; // 3 polls — survives one missed cycle, expires if the daemon dies
const SOURCE = "ci"; // metadata source namespace; scopes our tokens to this daemon

// Two CircleCI vars exist in this shell and only one works: CIRCLECI_TOKEN was
// revoked (401 on every endpoint, including /me) while CIRCLE_CI_TOKEN is live.
// Prefer the working one. `key-check --test` is what surfaced the difference —
// calendar expiry alone reported both as fine.
//
// Collapse this to a single var once the dead token is rotated out of keys.zsh.
const CIRCLECI_TOKEN = process.env.CIRCLE_CI_TOKEN || process.env.CIRCLECI_TOKEN;
const CIRCLECI_API = "https://circleci.com/api/v2";

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has("--dry-run");
const ONCE = ARGS.has("--once");
const NO_OPEN = ARGS.has("--no-open");

// ── CI status (from cursor-status.ts) ───────────────────────────────────────

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

interface CiJob {
  name: string;
  url: string;
}

interface Ci {
  status: CiStatus;
  url?: string;
  failedJobs?: CiJob[];
}

interface CircleJob {
  id: string;
  name: string;
  status: string;
  job_number?: number;
  type?: string;
}

// The statuses that mean "this needs your attention" — drives the red token.
const FAILING_STATUSES = new Set<CiStatus>(["failed", "failing", "error"]);
function isFailing(s: CiStatus): boolean {
  return FAILING_STATUSES.has(s);
}

// Job statuses worth counting. "canceled" and "not_run" are noise, not breakage.
const BAD_JOB_STATUS = new Set(["failed", "infrastructure_fail", "timedout", "terminated-unknown"]);

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

// Run `fn` over `items` with at most `limit` in flight. Per-branch CI means one
// request per branch instead of one for the whole repo, so they overlap — but
// not unboundedly, because CircleCI rate-limits and nine parallel bursts every
// 30s is a good way to find that out.
async function mapWithLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

// Branches that exist on origin. A branch with no `origin/<branch>` has never
// been pushed, so CircleCI cannot have a pipeline for it — asking is a
// guaranteed-empty round trip. Checking locally first is what keeps per-branch
// querying cheap: right now that's 9 branches down to 2 real requests.
async function pushedBranches(repoDir: string, branches: Set<string>): Promise<Set<string>> {
  const pushed = new Set<string>();
  await Promise.all(
    [...branches].map(async (branch) => {
      try {
        await execFileP("git", [
          "-C",
          repoDir,
          "show-ref",
          "--verify",
          "--quiet",
          `refs/remotes/origin/${branch}`,
        ]);
        pushed.add(branch);
      } catch {
        // no remote ref — nothing to query
      }
    })
  );
  return pushed;
}

// CI status for one branch, from that branch's own pipeline list.
//
// This replaces a single `pipeline/mine` call that was filtered client-side.
// `mine` returns only the ~20 most recent pipelines *you* triggered, which made
// coverage silently depend on how recently you'd pushed and lose any pipeline a
// teammate triggered on a shared branch. Querying `?branch=` costs a request per
// branch but answers the actual question — is this branch green — for every
// branch, regardless of who pushed it or how long ago.
async function ciForBranch(slug: string, branch: string): Promise<Ci | null> {
  let pipelines: { items?: any[] };
  try {
    pipelines = await cc<{ items?: any[] }>(
      `/project/${slug}/pipeline?branch=${encodeURIComponent(branch)}`
    );
  } catch {
    return null; // token/permissions/transient — leave this Space unpainted
  }

  const items = pipelines.items ?? [];
  if (items.length === 0) return null; // pushed, but CI never ran on it

  // The API appears to return newest-first, but pick the max explicitly rather
  // than trusting response order.
  const pipeline = items.reduce((a, b) => (b.number > a.number ? b : a));

  let workflows: { items?: { id: string; status: WorkflowStatus }[] };
  try {
    workflows = await cc<{ items?: { id: string; status: WorkflowStatus }[] }>(
      `/pipeline/${pipeline.id}/workflow`
    );
  } catch {
    return null;
  }
  const wfItems = workflows.items ?? [];
  if (wfItems.length === 0) return null;

  const status = worstStatus(wfItems.map((w) => w.status));
  const target = wfItems.find((w) => w.status === status) ?? wfItems[0];
  const ci: Ci = {
    status,
    url: `https://app.circleci.com/pipelines/${slug}/${pipeline.number}/workflows/${target.id}`,
  };

  // On failure, count the jobs that actually failed so the token can say how many.
  if (isFailing(status)) {
    const failedJobs: CiJob[] = [];
    for (const wf of wfItems) {
      if (!isFailing(wf.status)) continue;
      let jobs: { items?: CircleJob[] };
      try {
        jobs = await cc<{ items?: CircleJob[] }>(`/workflow/${wf.id}/job`);
      } catch {
        continue;
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

  return ci;
}

// CI status for every branch we have a Space for, one query per pushed branch.
async function ciForRepo(
  slug: string,
  branches: Set<string>,
  pushed: Set<string>
): Promise<Map<string, Ci>> {
  const map = new Map<string, Ci>();
  if (!CIRCLECI_TOKEN || branches.size === 0) return map;

  const unpushed = branches.size - pushed.size;
  if (unpushed) {
    log(`${unpushed}/${branches.size} branch(es) not on origin — no CI possible, not queried`);
  }
  if (pushed.size === 0) return map;

  await mapWithLimit([...pushed], CI_CONCURRENCY, async (branch) => {
    const ci = await ciForBranch(slug, branch);
    if (ci) map.set(branch, ci);
  });
  return map;
}

// ── Herdr socket API ────────────────────────────────────────────────────────

interface HerdrWorktree {
  branch: string;
  path: string;
  label: string;
  is_bare: boolean;
  is_detached: boolean;
  is_linked_worktree: boolean;
  is_prunable: boolean;
  open_workspace_id?: string;
}

// The CLI prints {"id":..., "result":{...}} on stdout; server errors are JSON on
// stderr with exit 1, which execFile surfaces as a rejection.
//
// Some mutating commands — `workspace report-metadata` among them — succeed
// silently with no stdout at all, so an empty body is success, not a parse
// failure. Only a non-zero exit means the write was rejected.
async function herdr<T>(args: string[]): Promise<T | undefined> {
  const { stdout } = await execFileP(HERDR, args, { maxBuffer: 8 << 20 });
  if (stdout.trim() === "") return undefined;
  const parsed = JSON.parse(stdout);
  if (parsed?.error) throw new Error(JSON.stringify(parsed.error));
  return parsed.result as T;
}

async function listWorktrees(repoDir: string): Promise<HerdrWorktree[]> {
  const res = await herdr<{ worktrees?: HerdrWorktree[] }>(["worktree", "list", "--cwd", repoDir]);
  return res?.worktrees ?? [];
}

// A worktree we're willing to represent as a Space. Prunable checkouts are
// already-deleted directories git hasn't reaped; bare and detached ones aren't a
// unit of work with a branch to report CI for.
function isSyncable(wt: HerdrWorktree): boolean {
  return !wt.is_prunable && !wt.is_bare && !wt.is_detached && Boolean(wt.branch);
}

// ── token mapping ───────────────────────────────────────────────────────────

// ── Space identity ──────────────────────────────────────────────────────────
//
// Spaces are created with `workspace create --cwd`, NOT `herdr worktree open`.
//
// `worktree open` attaches worktree metadata, and Herdr uses that metadata to
// group every Space sharing a repo_key under a single repo row — which is what
// drew the ├─ tree glyphs and buried nine worktrees under one "popmenu" entry.
// The grouping is not configurable; there is no rows_by_* or flat-mode option
// anywhere in `herdr --default-config`, and the membership struct is keyed on
// repo_root internally. A Space with no worktree metadata is top-level, which
// is the whole trick.
//
// The cost is that `herdr worktree list` no longer reports `open_workspace_id`
// for our Spaces, so identity has to be re-derived. A Space's first pane's cwd,
// resolved to its git top level, is that identity: it survives the user cd-ing
// into a subdirectory, and it is what the worktree actually IS.

interface Space {
  workspace_id: string;
  label: string;
  root: string | null; // git top level of the Space's first pane, if any
}

async function spaceRoot(w: any): Promise<string | null> {
  // Spaces predating this change still carry worktree metadata — believe it.
  if (w.worktree?.checkout_path) return w.worktree.checkout_path as string;
  let panes: { panes?: { cwd?: string }[] } | undefined;
  try {
    panes = await herdr<{ panes?: { cwd?: string }[] }>(["pane", "list", "--workspace", w.workspace_id]);
  } catch {
    return null;
  }
  const cwd = panes?.panes?.find((p) => p.cwd)?.cwd;
  if (!cwd) return null;
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return null; // pane is not inside a git repo — not one of ours
  }
}

async function listSpaces(): Promise<Space[]> {
  const res = await herdr<{ workspaces?: any[] }>(["workspace", "list"]);
  const ws = res?.workspaces ?? [];
  return Promise.all(
    ws.map(async (w) => ({
      workspace_id: w.workspace_id as string,
      label: w.label as string,
      root: await spaceRoot(w),
    }))
  );
}

// The glyph strip itself lives in herdr-space-tokens.ts — see that file's header
// for why one visual field costs several tokens (Herdr colours by token name, so
// a field with N colours needs N tokens with exactly one lit).

// A one-line summary of what a Space is about to be painted with, for --dry-run
// and the log. Prints the lit tokens only; the blanked majority is noise.
function describe(tokens: Record<string, string | null>): string {
  const lit = Object.entries(tokens).filter(([, v]) => v !== null);
  return lit.length ? lit.map(([k, v]) => `${k}="${v}"`).join(" ") : "(nothing to say)";
}

// Herdr caps a metadata report at 16 tokens, and the full strip is 22 (one
// name + fifteen glyph variants + three CI job slots + three comment slots), so
// a report has to be chunked. Chunking is safe because a report MERGES into the
// source's existing tokens rather than replacing them — which is also why the
// blanked tokens have to be sent as explicit --clear-token rather than omitted.
const MAX_TOKENS_PER_REPORT = 16;

// seq must strictly increase: Herdr discards an out-of-order seq SILENTLY — no
// error, no non-zero exit, the write just doesn't land. Date.now() alone is not
// enough now that one paint is several calls, because the chunks can share a
// millisecond and the later ones would be dropped as stale. So: epoch millis,
// bumped by one whenever the clock hasn't moved since the last call.
//
// It stays in epoch-milliseconds units on purpose. Any other writer touching
// these tokens must use the same scale — a seconds-resolution seq (`date +%s`)
// is ~1000x smaller and every one of its writes is ignored with no diagnostic.
let lastSeq = 0;
function nextSeq(): number {
  const now = Date.now();
  lastSeq = now > lastSeq ? now : lastSeq + 1;
  return lastSeq;
}

async function reportTokens(
  workspaceId: string,
  tokens: Record<string, string | null>
): Promise<void> {
  const entries = Object.entries(tokens);
  for (let i = 0; i < entries.length; i += MAX_TOKENS_PER_REPORT) {
    const chunk = entries.slice(i, i + MAX_TOKENS_PER_REPORT);
    const args = [
      "workspace",
      "report-metadata",
      workspaceId,
      "--source",
      SOURCE,
      "--ttl-ms",
      String(TOKEN_TTL_MS),
      "--seq",
      String(nextSeq()),
    ];
    for (const [name, value] of chunk) {
      if (value === null) args.push("--clear-token", name);
      else args.push("--token", `${name}=${value}`);
    }
    await herdr(args);
  }
}

// ── slow lane ───────────────────────────────────────────────────────────────
//
// CI is polled every 30s because a run finishing is the thing you're waiting on.
// PR state and review comments are not: an approval or a new comment is a
// minutes-scale event, and asking GitHub about it every 30s costs ~3,200 API
// calls an hour against a 5,000/hour limit — one busy afternoon from being
// rate-limited into a blank sidebar.
//
// So they ride a separate 5-minute lane, cached by branch in between. The cost
// of the split is that an approval can be up to five minutes stale; the ✓· field
// is a progress bar, not a notification, so that is the right trade.
const SLOW_LANE_SECONDS = 300;

let slowFetchedAt = 0;
let slowPrs = new Map<string, Pr>();
let slowComments = new Map<string, CommentSummary[]>();

// ── cycle ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${ts} ${DRY_RUN ? "[dry-run] " : ""}${msg}`);
}

async function cycle(): Promise<void> {
  for (const { dir, slug } of REPOS) {
    let worktrees: HerdrWorktree[];
    try {
      worktrees = await listWorktrees(dir);
    } catch (err) {
      log(`worktree list failed for ${dir}: ${(err as Error).message}`);
      continue;
    }

    // Tombstoned worktrees are dropped from EVERY use of `syncable`, not just
    // Space creation: painting tokens onto a Space that is being torn down is
    // the same mistake one step later.
    const removing = readRemoving();
    const syncable = worktrees.filter((wt) => isSyncable(wt) && !removing.has(wt.path));
    const skipped = worktrees.length - syncable.length;
    if (skipped) log(`${path.basename(dir)}: skipping ${skipped} bare/detached/prunable worktree(s)`);

    // 1. reconcile — a top-level Space per worktree, matched by git top level.
    let spaces = await listSpaces();

    // Several Spaces can sit on the same root — the repo checkout typically has
    // one from `worktree open` and another you opened by hand. Building the map
    // by plain assignment let the last one silently win, which moved the paint
    // onto whichever Space happened to be listed later. Prefer the one already
    // labelled after the directory; otherwise keep the first seen, so the choice
    // is at least stable across cycles.
    const spaceByRoot = new Map<string, Space>();
    for (const sp of spaces) {
      if (!sp.root) continue;
      const existing = spaceByRoot.get(sp.root);
      if (!existing) {
        spaceByRoot.set(sp.root, sp);
        continue;
      }
      const want = path.basename(sp.root);
      if (existing.label !== want && sp.label === want) spaceByRoot.set(sp.root, sp);
    }

    if (!NO_OPEN) {
      for (const wt of syncable) {
        if (spaceByRoot.has(wt.path)) continue;
        const label = path.basename(wt.path);
        if (DRY_RUN) {
          log(`would create Space for ${label} (${wt.branch})`);
          continue;
        }
        try {
          // --label is what line 1 renders, so it is the worktree directory
          // name rather than anything Herdr would infer.
          const res = await herdr<any>([
            "workspace", "create", "--cwd", wt.path, "--label", label, "--no-focus",
          ]);
          const id = res?.workspace?.workspace_id;
          if (id) {
            const sp = { workspace_id: id, label, root: wt.path };
            spaces.push(sp);
            spaceByRoot.set(wt.path, sp);
            log(`created Space ${id} for ${label} (${wt.branch})`);
          }
        } catch (err) {
          log(`could not create Space for ${label}: ${(err as Error).message}`);
        }
      }
    }

    // Keep the label honest for Spaces this daemon named — but never over a
    // rename the user made by hand. See readDaemonNames().
    const nameState = readNameState();
    if (!DRY_RUN) {
      for (const wt of syncable) {
        const sp = spaceByRoot.get(wt.path);
        if (!sp) continue;
        const want = path.basename(wt.path);
        const st = nameState[sp.workspace_id];

        // First sight: record what is there, rename nothing.
        if (!st) {
          nameState[sp.workspace_id] = { set: sp.label, pinned: false };
          continue;
        }
        // Renamed back to the directory name — nothing left to disagree about.
        if (st.pinned && sp.label === want) {
          nameState[sp.workspace_id] = { set: want, pinned: false };
          continue;
        }
        // Already pinned: track the label so line 1 follows it, never rename.
        if (st.pinned) {
          st.set = sp.label;
          continue;
        }
        // Moved off what we wrote: a human did that. Pin it for good.
        if (sp.label !== st.set) {
          st.pinned = true;
          st.set = sp.label;
          log(`pinned hand-set name for ${sp.workspace_id}: "${sp.label}"`);
          continue;
        }
        if (sp.label === want) continue;
        try {
          const from = sp.label;
          await herdr(["workspace", "rename", sp.workspace_id, want]);
          sp.label = want;
          st.set = want;
          log(`renamed ${sp.workspace_id} "${from}" → "${want}"`);
        } catch (err) {
          log(`rename failed for ${sp.workspace_id}: ${(err as Error).message}`);
        }
      }
      // Same reason as the sidecars: ids are never reused, so drop the dead.
      const liveSpaceIds = new Set(spaces.map((s) => s.workspace_id));
      for (const id of Object.keys(nameState)) {
        if (!liveSpaceIds.has(id)) delete nameState[id];
      }
      writeNameState(nameState);
    }

    // 2. paint — the whole glyph strip, for every worktree that has a Space.
    //
    // No CircleCI-token gate: the PR, Shortcut, hubdiff and name signals are all
    // resolvable without it, and a missing CI token should cost the CI dot
    // rather than the entire sidebar.
    const live = syncable
      .map((wt) => ({ wt, space: spaceByRoot.get(wt.path) }))
      .filter((x): x is { wt: HerdrWorktree; space: Space } => Boolean(x.space));
    if (live.length === 0) continue;

    const collapsed = readCollapsed();
    const announced = readMergeReady();
    const failAnnounced = readCiFailed();
    const sbWidth = sidebarWidth();
    const branches = new Set(live.map(({ wt }) => wt.branch));
    const mainBranches = new Set(
      live.filter(({ wt }) => !wt.is_linked_worktree).map(({ wt }) => wt.branch)
    );
    const repo = githubRepo(slug);

    // Every signal for the whole repo is gathered before any Space is painted,
    // so one slow lookup delays the strip rather than painting it in pieces and
    // letting the sidebar flicker through half-states.
    const pushed = await pushedBranches(dir, branches);
    const ciMap = slug ? await ciForRepo(slug, branches, pushed) : new Map<string, Ci>();
    const devDirs = await devServerDirs();

    // Attribute each dev-server cwd to the LONGEST matching worktree path.
    // A server's cwd can sit in a subdir, and one worktree can nest inside
    // another's path (popmenu-worktrees/AIM-2.0-Planning-worktrees is real),
    // so most specific wins. The `.some()` this replaces lit BOTH the outer
    // and the inner worktree — and now that dev state colours the NAME, a
    // false positive renames a Space rather than adding a stray glyph.
    // Ported from cursor-status.ts, which has always done it this way.
    const devOwner = new Set<string>();
    for (const cwd of devDirs) {
      let best = "";
      for (const { wt } of live) {
        if (cwd === wt.path || cwd.startsWith(wt.path + path.sep)) {
          if (wt.path.length > best.length) best = wt.path;
        }
      }
      if (best) devOwner.add(best);
    }
    const tierMap = await shortcutTiers([...branches]);

    // PR + comments on the slow lane; CI and the local signals refresh every cycle.
    const slowDue = Date.now() - slowFetchedAt >= SLOW_LANE_SECONDS * 1000;
    if (slowDue) {
      // One `gh` call per branch, bounded the same way CI is — `gh` is a network
      // round trip too, and nine at once is how you find GitHub's rate limit.
      const prs = new Map<string, Pr>();
      await mapWithLimit([...branches], CI_CONCURRENCY, async (branch) => {
        prs.set(branch, await resolvePr(repo, branch));
      });

      // Comments only for PRs that are still open and not master's: a merged
      // PR's review notes are history, and master's belong to the team.
      const comments = new Map<string, CommentSummary[]>();
      if (repo) {
        await mapWithLimit([...branches], CI_CONCURRENCY, async (branch) => {
          const pr = prs.get(branch);
          if (!pr?.number || pr.merged) return;
          if (mainBranches.has(branch)) return;
          try {
            const raw = await fetchComments(repo, pr.number);
            comments.set(branch, await summarizeComments(raw));
          } catch (err) {
            log(`comments failed for ${branch}: ${(err as Error).message}`);
          }
        });
      }

      // Swapped in only once both finish, so a cycle never paints new PR state
      // against last lane's comments.
      slowPrs = prs;
      slowComments = comments;
      slowFetchedAt = Date.now();
    }
    const prMap = slowPrs;
    const cmtMap = slowComments;
    // Cheap (one small file) and re-read each cycle so an edit to CODEOWNERS
    // shows up without restarting the daemon.
    const archPatterns = architecturePatterns(dir);

    let painted = 0;
    for (const { wt, space } of live) {
      // $wt is what line 1 draws, so it follows the label rather than the
      // directory — otherwise a hand-set name would stick in `workspace list`
      // and still render as the worktree basename in the sidebar.
      const worktreeName = space.label || path.basename(wt.path);
      const input = {
        worktreeName,
        branch: wt.branch,
        path: wt.path,
        isMain: !wt.is_linked_worktree,
        collapsed: collapsed.has(wt.path),
        sidebarWidth: sbWidth,
        ci: ciMap.get(wt.branch),
        pushed: pushed.has(wt.branch),
        pr: prMap.get(wt.branch) ?? NO_PR,
        archLock: needsArchitecture(
          (prMap.get(wt.branch) ?? NO_PR).paths,
          archPatterns
        ),
        repo,
        scTier: tierMap.get(wt.branch) as ScTier | undefined,
        devRunning: devOwner.has(wt.path),
        comments: cmtMap.get(wt.branch) ?? [],
      };
      // Edge-triggered, and deliberately not gated on DRY_RUN's `continue`
      // below: a dry run should still say what it WOULD announce.
      const pr = input.pr;
      const ready = mergeReady(pr, input.ci);
      if (ready && !announced.has(wt.branch)) {
        announced.add(wt.branch);
        if (DRY_RUN) log(`would notify: #${pr.number} ${worktreeName} ready to merge`);
        else await notifyMergeReady(worktreeName, pr);
      } else if (!ready && announced.has(wt.branch)) {
        announced.delete(wt.branch);
      }

      // CI failure, same edge shape. Guarded on input.ci existing at all: a
      // null ci means the CircleCI call failed or the branch has no pipeline,
      // which is not the same as red and must not announce.
      const ciFailing = input.ci !== undefined && isFailing(input.ci.status);
      if (ciFailing && !failAnnounced.has(wt.branch)) {
        failAnnounced.add(wt.branch);
        if (DRY_RUN) log(`would notify: ${worktreeName} CI failed`);
        else await notifyCiFailed(worktreeName, pr, input.ci!);
      } else if (!ciFailing && failAnnounced.has(wt.branch)) {
        failAnnounced.delete(wt.branch);
      }

      const tokens = buildTokens(input);
      if (DRY_RUN) {
        log(`${space.workspace_id} ${worktreeName} → ${describe(tokens)}`);
        continue;
      }
      try {
        await reportTokens(space.workspace_id, tokens);
        // The main checkout is bare in the sidebar but still worth a menu — its
        // CI and diff are real, it just has no story or PR of its own.
        writeSidecar(space.workspace_id, {
          name: worktreeName,
          branch: wt.branch,
          path: wt.path,
          links: buildLinks(input, slug),
        });
        painted++;
      } catch (err) {
        log(`report-metadata failed for ${space.workspace_id}: ${(err as Error).message}`);
      }
    }
    // Line 1 renders $wtdev/$wtidle and nothing else, so a Space this daemon
    // does not manage — System, the ad-hoc one you opened at the repo root, a
    // fresh Space not reconciled yet — would draw as a bare state icon with no
    // name at all. Give every remaining Space its Herdr label so none render
    // blank. $wtidle specifically: an unmanaged Space has no worktree, so it
    // cannot be the one holding :3000 and must never take the green.
    //
    // This said `wt` until 2026-10-28, which is what the row used to render.
    // When the name moved to the colour pair, this was missed and the System
    // Space went nameless — the token was still pushed, just no longer drawn.
    if (!DRY_RUN) {
      pruneSidecars(new Set(spaces.map((sp) => sp.workspace_id)));
      const named = new Set(live.map(({ space }) => space.workspace_id));
      for (const sp of spaces) {
        if (named.has(sp.workspace_id) || !sp.label) continue;
        try {
          await reportTokens(sp.workspace_id, { wtidle: sp.label });
        } catch {
          /* a Space closed mid-cycle — next cycle will not see it */
        }
      }
    }

    if (!DRY_RUN) writeMergeReady(announced);
    if (!DRY_RUN) writeCiFailed(failAnnounced);

    if (!DRY_RUN) {
      log(
        `painted ${painted}/${live.length} Space(s) for ${path.basename(dir)}` +
          ` (${ciMap.size} with CI, ${prMap.size} PR lookups, ${cmtMap.size} with comments)`
      );
    }
  }
}

async function main(): Promise<void> {
  if (ONCE) {
    await cycle();
    return;
  }
  writePid();

  // SIGUSR1 cuts the wait short. The collapse toggle writes its state file and
  // signals us, so a fold lands immediately instead of up to POLL_SECONDS later.
  let wake: (() => void) | null = null;
  process.on("SIGUSR1", () => wake?.());

  // Poll forever. cycle() swallows its own per-repo errors, so a transient
  // failure costs one cadence rather than the daemon.
  for (;;) {
    try {
      await cycle();
    } catch (err) {
      log(`cycle failed: ${(err as Error).message}`);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, POLL_SECONDS * 1000);
      function finish() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = finish;
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
