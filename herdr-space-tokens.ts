/**
 * herdr-space-tokens — the glyph strip that herdr-sync paints onto each Herdr Space.
 *
 * This is the port of cursor-status.ts's per-worktree row into Herdr's sidebar.
 * It is a PORT, not a move: the two dashboards answer the same question and are
 * kept deliberately similar, but they render through completely different
 * mechanisms and neither can be expressed in the other's terms.
 *
 * ── What Herdr's sidebar can and cannot do (0.8.2, verified) ─────────────────
 * Herdr is a closed-source binary; the sidebar is not a terminal and the only
 * way to put anything in it is `herdr workspace report-metadata`. Three limits
 * shape everything below:
 *
 *   1. NO LINKS. Metadata values are plain strings and Herdr STRIPS control
 *      bytes on the way in — an OSC 8 hyperlink round-trips as the literal text
 *      `]8;;https://…\CLICKME]8;;\`, escape removed. There is no url/action
 *      field on a row token either. So cursor-status.ts's cmd-click targets
 *      cannot survive the move; they become keybindings on the focused Space
 *      instead (see ~/.config/herdr/bin/space-open-*.zsh).
 *
 *   2. ONE COLOUR PER TOKEN. Colour lives in config.toml, keyed by token name,
 *      and a metadata value carries no styling of its own. A single `$ci` token
 *      could therefore only ever be one colour. The workaround — already used by
 *      herdr-sync's original three CI tokens — is to declare one token per
 *      colour variant and light exactly one, clearing its siblings. That is why
 *      `pr_o`/`pr_u`/`pr_n`/`pr_m` are four tokens rather than one with four
 *      values, and it's why this file is mostly a set of small "pick one of N"
 *      functions.
 *
 *   3. ROWS ARE STATIC AND GLOBAL. There is one row list for every Space —
 *      no per-Space rows, no conditionals (`rows_by_agent` exists for agents;
 *      spaces have no equivalent). So "extra lines when CI fails" has to be
 *      pre-declared, fixed slots: cij1..3 and cmt1..3. A row whose every token
 *      is empty COLLAPSES rather than reserving a blank line (verified), which
 *      is what makes fixed slots affordable — a Space with nothing to say is
 *      still two lines tall.
 *
 * ── Spacing ─────────────────────────────────────────────────────────────────
 * Herdr joins the tokens in a row itself, so values here are BARE GLYPHS with no
 * padding. Approvals are the exception: `✓·` has two colours but must not be
 * split by the join, so they are three whole-field tokens (ap_2/ap_1/ap_0)
 * rather than a green token beside a dim one.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);
const HOME = os.homedir();

// `gh` by bare name is a trap under launchd. /opt/homebrew/bin only reaches PATH
// via path_helper in /etc/zprofile, and a non-login shell never reads that file —
// so herdr-sync's `zsh -ic` had node (nvm, from .zshrc) but no gh. Every call
// below threw ENOENT straight into a quiet catch, which is why every PR read as
// zero approvals and no comments for weeks with nothing in the log. Resolved
// absolute, the way HERDR is in herdr-sync.ts, with a PATH lookup as the
// last-resort fallback for machines where brew lives somewhere else.
const GH = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find((p) => fs.existsSync(p)) ?? "gh";

// ── the token vocabulary ────────────────────────────────────────────────────
// Every token this module owns. Painting blanks the whole set first, so a
// signal that disappears (PR merged, CI job fixed) clears instead of lingering
// until its TTL. Order here is documentation only; row order lives in config.toml.
export const SPACE_TOKENS = [
  "wt", // line 1: the Space's display name
  // Line 1 tail: approvals, then exactly one CI token — colour carries the
  // state, so they share a single column between them.
  "appr", // approvals, flush after the name
  // cipad and appr are retired but stay listed so blankTokens() clears the
  // values Herdr still holds for them. Safe to drop after one paint.
  "cipad", "appr",
  // Approval field. Exactly one is set: green when any tick is present, grey
  // when it is all dashes. Two tokens rather than one because Herdr's colour is
  // per-token and metadata cannot carry inline escapes (control bytes stripped).
  "apprg", "apprd",
  "ciok", "cirun", "cifail", "cinone", // CI dot, flush after the name
  // line 1 status strip, fixed width so rows align: two approval slots then one
  // CI circle. Exactly one ci* token is ever set — Herdr's colour is per-token,
  // so a state that needs its own colour needs its own token.
  "appr",
  "ciok", "cirun", "cifail", "cinone",
  // Each tree row is TWO tokens: a grey prefix carrying the right-align padding
  // and the ├─/└─ glyph, then the text itself in its own colour.
  "cijp1", "cijp2", "cijp3", "cijp4",
  "cij1", "cij2", "cij3", "cij4", // failing CI jobs
  "cmtp1", "cmtp2", "cmtp3", "cmtp4", "cmtp5", "cmtp6",
  "cmt1", "cmt2", "cmt3", "cmt4", "cmt5", "cmt6", // summarised PR comments
] as const;

export type Tokens = Record<string, string | null>;

export function blankTokens(): Tokens {
  const t: Tokens = {};
  for (const name of SPACE_TOKENS) t[name] = null;
  return t;
}

// ── glyphs ──────────────────────────────────────────────────────────────────
// Same glyphs as cursor-status.ts, and for the same reason: every one is
// single-width and text-presentation in a plain font, so the strip cannot
// reflow depending on whether a Nerd Font or emoji fallback is installed.
// The comment rows are the deliberate exception — those emoji are the label.
const CI_GLYPH = "●";
const GIT_GLYPH = "⎇";
const MERGED_GLYPH = "↥";
const SC_GLYPH = "◆";
const DIFF_GLYPH = "±";
const DEV_GLYPH = "◂";
const JOB_PREFIX = "⎿";

// Absent fields render NOTHING — no placeholder.
//
// The strip was briefly column-aligned by holding each empty field with a dim
// `·`, the way cursor-status.ts pads with spaces. Padding with spaces is not
// available (Herdr trims whitespace out of metadata values), so the holder had
// to be visible, and a visible holder is also a token — which means Herdr adds
// its inter-token separator on BOTH sides of it. Three empty fields turned into
// three dots surrounded by six separator cells, and the strip read as mostly
// punctuation.
//
// So: uniformity lost, noise gone. Glyphs shift between Spaces depending on
// which signals exist. That is the deliberate trade — with fewer lit tokens the
// strip is also tighter, because each unlit field costs no separator either.

export const APPROVALS_NEEDED = 2;

// ── CI ──────────────────────────────────────────────────────────────────────

export type CiStatus =
  | "success" | "running" | "on_hold" | "failed" | "failing"
  | "error" | "canceled" | "not_run" | "unauthorized" | "unknown";

export interface CiJob {
  name: string;
  url: string;
}

export interface Ci {
  status: CiStatus;
  url?: string;
  failedJobs?: CiJob[];
}

const FAILING_STATUSES = new Set<CiStatus>(["failed", "failing", "error"]);
export function isFailing(s: CiStatus): boolean {
  return FAILING_STATUSES.has(s);
}

// ── PR ──────────────────────────────────────────────────────────────────────

export interface Pr {
  url: string | null;
  number: number | null;
  approvals: number;
  // GitHub's own verdict on whether the merge button is live: CLEAN, BLOCKED,
  // BEHIND, DIRTY, UNSTABLE, ... A repo-wide merge freeze shows up here as
  // BLOCKED even when checks are green and reviews are in, which is what makes
  // the CLEAN transition usable as an "unfrozen" edge.
  mergeStateStatus: string | null;
  isDraft: boolean;
  merged: boolean;
  paths: string[]; // changed files, for the CODEOWNERS check below
}

export const NO_PR: Pr = {
  url: null, number: null, approvals: 0, merged: false, paths: [],
  mergeStateStatus: null, isDraft: false,
};

// ── architecture sign-off ───────────────────────────────────────────────────
//
// GitHub will NOT tell you this. On a PR that touches db/migrate, the API
// reports requested_teams: [] and reviewDecision: "" while mergeable_state is
// "blocked" — the requirement lives in branch protection's code-owner rule, not
// in a review request. So derive it the same way GitHub does: match the changed
// files against the @Popmenu/architecture lines in .github/CODEOWNERS.
//
// Consequence worth remembering: the lock means "architecture owns something in
// here", not "GitHub is blocking on them right now".
const ARCH_OWNER = "@Popmenu/architecture";
const ARCH_LOCK = "\uf023"; // Nerd Font nf-fa-lock: one cell, unlike 🔒's two

export function architecturePatterns(repoRoot: string): RegExp[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(repoRoot, ".github/CODEOWNERS"), "utf8");
  } catch {
    return [];
  }
  const out: RegExp[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes(ARCH_OWNER)) continue;
    const pat = t.split(/\s+/)[0];
    if (!pat) continue;
    // CODEOWNERS globbing, the subset that actually appears in this file:
    // leading "/" anchors at the repo root, a bare name matches at any depth,
    // "*" stops at a path separator, a trailing "/" matches everything below.
    const anchored = pat.startsWith("/");
    let body = anchored ? pat.slice(1) : pat;
    const dir = body.endsWith("/");
    if (dir) body = body.slice(0, -1);
    const rx = body.split("*").map((seg) =>
      seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
    out.push(new RegExp(`^${anchored ? "" : "(?:.*/)?"}${rx}${dir ? "/" : ""}`));
  }
  return out;
}

export function needsArchitecture(paths: string[] | undefined, patterns: RegExp[]): boolean {
  if (!patterns.length || !paths?.length) return false;
  return paths.some((f) => patterns.some((rx) => rx.test(f)));
}

// "gh/Popmenu/popmenu" → "Popmenu/popmenu". Non-gh CircleCI slugs have no
// GitHub repo behind them.
export function githubRepo(slug: string | null): string | null {
  if (!slug) return null;
  const m = slug.match(/^gh\/([^/]+)\/([^/]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Straight port of cursor-status.ts's resolvePr, made async so a slow `gh` on
// one branch doesn't stall the others. `--state all` so a MERGED pr still
// resolves, and `--limit 1` takes the most recent PR for the head. latestReviews
// rides along in the same call, so the approval count is free.
//
// Still resolved even though no glyph shows it any more: the popup menu's PR row
// needs the URL, number and approval count.
export async function resolvePr(repo: string | null, branch: string): Promise<Pr> {
  if (!repo) return NO_PR;
  try {
    const { stdout } = await execFileP(
      GH,
      ["pr", "list", "--repo", repo, "--head", branch, "--state", "all",
       "--json", "url,number,state,latestReviews,files,mergeStateStatus,isDraft",
       "--limit", "1",
       "--jq", '.[0] // empty | {url, number, merged: (.state == "MERGED"), approvals: ([.latestReviews[] | select(.state=="APPROVED")] | length), paths: [.files[]?.path], mergeStateStatus, isDraft}'],
      { timeout: 8000 }
    );
    const out = stdout.trim();
    if (!out) return NO_PR;
    const o = JSON.parse(out);
    return {
      url: o.url ?? null,
      number: o.number ?? null,
      approvals: o.approvals ?? 0,
      merged: o.merged ?? false,
      paths: o.paths ?? [],
      mergeStateStatus: o.mergeStateStatus ?? null,
      isDraft: o.isDraft ?? false,
    };
  } catch (err) {
    // A missing binary is a config fault that will never clear on its own, unlike
    // a rate limit or a timeout. Say so on stderr — the launchd log — instead of
    // reporting every PR in the sidebar as unapproved in silence.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`gh not found at ${GH} — PR state unavailable`);
    }
    return NO_PR; // unauthed, rate-limited, or slow — fail quiet
  }
}

// ── Shortcut ────────────────────────────────────────────────────────────────

export type ScTier = "idle" | "active" | "qa" | "ship" | "done";

export function shortcutId(branch: string): string | undefined {
  const m = branch.match(/sc-(\d+)/i);
  return m ? m[1] : undefined;
}

// ── dev server ──────────────────────────────────────────────────────────────

const DEV_PORT = 3000;

// cwd(s) of whatever is listening on DEV_PORT — port → PID(s), then PID → cwd.
// Ported from cursor-status.ts. Any failure means "nobody's serving".
export async function devServerDirs(): Promise<Set<string>> {
  const dirs = new Set<string>();
  let portOut: string;
  try {
    ({ stdout: portOut } = await execFileP("lsof", ["-nP", `-iTCP:${DEV_PORT}`, "-sTCP:LISTEN"]));
  } catch {
    return dirs;
  }
  const pids = new Set<number>();
  for (const line of portOut.trim().split("\n").slice(1)) {
    const pid = parseInt(line.split(/\s+/)[1], 10); // COMMAND PID USER …
    if (!Number.isNaN(pid)) pids.add(pid);
  }
  await Promise.all(
    [...pids].map(async (pid) => {
      try {
        const { stdout } = await execFileP("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
        const cwd = stdout.split("\n").find((l) => l.startsWith("n"))?.slice(1).trim();
        if (cwd) dirs.add(cwd);
      } catch {
        /* PID died between the two calls */
      }
    })
  );
  return dirs;
}

// ── the tree under a Space ──────────────────────────────────────────────────
//
// The glyph strip is gone; what hangs under a Space's name now is a tree of
// things to act on — failing CI jobs first, then review comments.
//
// Indented with U+2800 BRAILLE PATTERN BLANK, not a space. Herdr trims
// whitespace off metadata values, and it trims Unicode whitespace, so a leading
// " " and even a non-breaking space both arrive stripped. U+2800 renders blank,
// is single-width, and is not White_Space, so it is the one character that
// survives as indentation. (Verified: "⠀├─ x" round-trips intact, "  ├─ x" and
// "\u00a0├─ x" both come back flush.)
const INDENT = "⠀";
const BRANCH = "├─";
const LAST = "└─";

const JOB_SLOTS = ["cij1", "cij2", "cij3", "cij4"];
const CMT_SLOTS = ["cmt1", "cmt2", "cmt3", "cmt4", "cmt5", "cmt6"];

// The tree glyph goes in its OWN token so it can be grey while the text is not —
// Herdr colours by token name, so anything sharing a token shares a colour.
const JOB_PREFIX_SLOTS = ["cijp1", "cijp2", "cijp3", "cijp4"];
const CMT_PREFIX_SLOTS = ["cmtp1", "cmtp2", "cmtp3", "cmtp4", "cmtp5", "cmtp6"];

// Herdr puts its own separator between the two tokens on a row. Its width is not
// documented and cannot be read back, so it is a constant. Off-by-one here shifts
// every padded row equally.
const SEPARATOR_CELLS = 1;

// Cells one U+2800 occupies. It SHOULD be single-width — but it renders as two
// in this terminal's font, which is how the right-aligned comment rows turned
// into a staircase: rows needing more padding overshot in proportion to how much
// they needed. Padding is therefore divided by this. If a padded row lands short
// or long, this is the constant to change (1 or 2), not the arithmetic.
const PAD_CELL_WIDTH = 2;

function pad(cells: number): string {
  return INDENT.repeat(Math.max(1, Math.ceil(cells / PAD_CELL_WIDTH)));
}

// Terminal cells a string occupies. Needed because right-alignment means padding
// to a column count, and the comment emoji are double-width — measuring in
// codepoints would leave every emoji row a cell short.
//
// Deliberately a heuristic, not a Unicode width table: the only wide characters
// that reach here are the summariser's emoji, and being one cell off is cosmetic.
function cellWidth(text: string): number {
  const cps = [...text].map((c) => c.codePointAt(0)!);
  let w = 0;
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (cp === 0xfe0f || cp === 0x200d) continue; // variation selector / ZWJ
    const emojiPresented = cps[i + 1] === 0xfe0f;
    if (cp >= 0x1f000 || emojiPresented || cp === 0x26a1 || cp === 0x2753) w += 2;
    else w += 1;
  }
  return w;
}

// Jobs and comments share ONE tree, so the elbow belongs to whichever row is
// last overall — a └─ on the last CI job followed by three ├─ comments would
// read as two separate trees.
function treeRows(
  ci: Ci | undefined,
  comments: CommentSummary[],
  collapsed: boolean,
  sidebarWidth: number
): Tokens {
  const out: Tokens = {};

  const jobs = ci?.failedJobs ?? [];
  const jobsShown = jobs.slice(0, JOB_SLOTS.length);
  const jobsDropped = jobs.length - jobsShown.length;

  // Collapsed: one summary row instead of the thread. Failing CI jobs are NOT
  // collapsible — they are breakage, not discussion, and there are at most four.
  const cmtsKept = collapsed
    ? []
    : comments.slice(0, CMT_SLOTS.length).reverse(); // newest N, oldest first,
                                                     // so the thread grows down
  const cmtsDropped = collapsed ? 0 : comments.length - cmtsKept.length;

  const rows: { slot: string; prefixSlot: string; text: string }[] = [
    ...jobsShown.map((j, i) => ({
      slot: JOB_SLOTS[i],
      prefixSlot: JOB_PREFIX_SLOTS[i],
      text:
        i === jobsShown.length - 1 && jobsDropped > 0
          ? `${j.name} +${jobsDropped} more`
          : j.name,
    })),
    ...cmtsKept.map((c, i) => ({
      slot: CMT_SLOTS[i],
      prefixSlot: CMT_PREFIX_SLOTS[i],
      text: i === 0 && cmtsDropped > 0
        ? `${c.emoji} ${c.subject} (+${cmtsDropped} earlier)`
        : `${c.emoji} ${c.subject}`,
    })),
  ];

  if (collapsed && comments.length > 0) {
    rows.push({
      slot: CMT_SLOTS[0],
      prefixSlot: CMT_PREFIX_SLOTS[0],
      text: `💬 ${comments.length} comment${comments.length === 1 ? "" : "s"}`,
    });
  }

  // Left-justified, one indent deep. Right-aligning these was tried and looked
  // like a staircase: U+2800 is double-width here, so each row overshot in
  // proportion to how much padding it needed.
  rows.forEach((r, i) => {
    out[r.prefixSlot] = INDENT + (i === rows.length - 1 ? LAST : BRANCH);
    out[r.slot] = r.text;
  });
  return out;
}

// Line 1 is NOT padded. Pushing the CI dot to the right edge meant computing a
// run of U+2800 from the sidebar width, and any over-estimate made the row wider
// than the sidebar — so Herdr truncated it and drew an ellipsis, on short names
// most visibly. The dot now sits flush after the name: "-- name ●". The only
// ellipsis left is Herdr's own, on a name genuinely too long for the sidebar.

// ── assembling one Space ────────────────────────────────────────────────────

export interface SpaceInput {
  worktreeName: string; // directory basename — NOT the branch (they diverge:
                        // steele/sc-174222/p1-extend-… lives in p1-extend-…)
  branch: string;
  path: string; // absolute worktree path — the hubdiff link's only input
  // The repo's MAIN checkout, not a linked worktree. Its "PR" is whatever
  // unrelated thing happens to have master as its head and its review comments
  // belong to the team, so it gets a name and nothing else.
  isMain: boolean;
  ci?: Ci;
  // Fold this Space's comments to a single summary row. Per-Space and sticky —
  // Herdr's own collapse (Expand / Close group, collapsed_space_keys) only ever
  // applied to repo groups, and flattening the Spaces removed those.
  collapsed: boolean;
  // The PR touches a path @Popmenu/architecture owns in CODEOWNERS.
  archLock: boolean;
  sidebarWidth: number; // live, from session.json — rows re-align when you drag
  pushed: boolean;
  pr: Pr;
  repo: string | null;
  scTier?: ScTier;
  devRunning: boolean;
  comments: CommentSummary[];
}

export function buildTokens(i: SpaceInput): Tokens {
  const t = blankTokens();
  // The main checkout has no PR and no branch CI of its own: name only, as before.
  if (i.isMain) {
    t.wt = i.worktreeName;
    return t;
  }

  // Approval slots. Placeholders rather than a bare count so the field is always
  // APPROVALS_NEEDED wide and the name starts in the same column on every row:
  // "--" none, "✓-" one of two, "✓✓" ready. Merged PRs zero it out.
  const approvals = i.pr.merged ? 0 : Math.min(i.pr.approvals, APPROVALS_NEEDED);
  const empty = APPROVALS_NEEDED - approvals;

  // Slots live in their own token so a tick can be green. That reinstates
  // Herdr's between-token separator ahead of the name — the merged version had
  // no gap but forced one colour on both. Whole field goes green as soon as
  // there is a tick: the trailing dash in "✓-" cannot stay grey without a third
  // token, and a separator would land between the tick and the dash.
  // Ticks green, dashes and the architecture lock grey. Colour beats spacing
  // here by explicit choice: both tokens set means Herdr draws its separator
  // between them ("✓ "), and metadata cannot carry inline escapes to avoid it.
  // The lock takes the LAST empty slot — "one of the dashes" — and is a
  // single-cell Nerd Font glyph so the field keeps its width.
  if (approvals > 0) t.apprg = "✓".repeat(approvals);
  if (empty > 0) t.apprd = "-".repeat(empty - 1) + (i.archLock ? ARCH_LOCK : "-");
  t.wt = i.worktreeName;

  // One circle, coloured by CI state. Hollow when there is nothing to report so
  // the column still holds its width instead of collapsing.
  const st = i.ci?.status;
  const slot =
    st === "success" ? "ciok"
    : st === "running" || st === "on_hold" ? "cirun"
    : st && isFailing(st) ? "cifail"
    : "cinone";
  t[slot] = slot === "cinone" ? "○" : "●";

  Object.assign(t, treeRows(i.ci, i.comments, i.collapsed, i.sidebarWidth));
  return t;
}

// ── PR comments ─────────────────────────────────────────────────────────────

export interface CommentSummary {
  id: string;
  emoji: string;
  subject: string;
  url: string; // deep link to the comment itself — the sidebar can't use it
               // (no links in metadata), but the popup menu can
}

// Comments read top-to-bottom in the order they were left, so a new one appears
// at the BOTTOM of the block and the thread grows downward the way a thread
// does. `comments` arrives newest-first (that is the order fetchComments sorts
// in, because when the list has to be truncated it is the recent ones you want),
// so this keeps the newest slots-worth and then flips them back into reading
// order. When older comments are dropped, the top row says so — a block that
// silently starts mid-thread looks like the whole thread.
function commentRows(comments: CommentSummary[]): Tokens {
  const slots = ["cmt1", "cmt2", "cmt3", "cmt4", "cmt5", "cmt6"];
  const out: Tokens = {};
  if (comments.length === 0) return out;

  const kept = comments.slice(0, slots.length).reverse(); // newest N, oldest first
  const dropped = comments.length - kept.length;
  kept.forEach((c, i) => {
    const label = `${c.emoji} ${c.subject}`;
    out[slots[i]] = i === 0 && dropped > 0 ? `${label} (+${dropped} earlier)` : label;
  });
  return out;
}

export interface RawComment {
  id: string;
  author: string;
  body: string;
  url: string;
}

// Review comments (the inline ones, where Bugbot and human reviewers actually
// leave findings) plus the conversation thread. Both are fetched because they
// carry different things: inline comments are about a line, conversation
// comments are about the PR. Newest first — a 40-comment PR still only has
// three slots, and the recent ones are the ones you haven't dealt with.
// Comment ids belonging to RESOLVED review threads.
//
// REST has no field for this. `pulls/{n}/comments` exposes `position: null` for
// GitHub-"outdated" (the diff moved under the comment), which is a DIFFERENT and
// much rarer thing — on the PRs this was built against, resolved was 1 and 2
// while outdated was 1 and 0. Resolution lives on the thread, and threads are
// GraphQL-only. Every comment in the thread is returned, not just the first,
// because each reply comes back as its own REST comment.
async function resolvedCommentIds(repo: string, prNumber: number): Promise<Set<string>> {
  const [owner, name] = repo.split("/");
  try {
    const { stdout } = await execFileP(
      GH,
      ["api", "graphql", "-f", `query=query($o:String!,$r:String!,$n:Int!){
        repository(owner:$o,name:$r){ pullRequest(number:$n){
          reviewThreads(first:100){ nodes{ isResolved comments(first:100){ nodes{ databaseId } } } } } } }`,
       "-F", `o=${owner}`, "-F", `r=${name}`, "-F", `n=${prNumber}`,
       "--jq", '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved) | .comments.nodes[].databaseId] | @csv'],
      { timeout: 10_000 }
    );
    return new Set(stdout.trim().replace(/"/g, "").split(",").filter(Boolean));
  } catch {
    return new Set(); // unauthed, rate-limited, or schema moved — show everything
  }
}

// Authors whose TOP-LEVEL comments are boilerplate, not review. Scoped to the
// issue-level endpoint only — Bugbot's inline comments are real findings and
// must survive. On a sample PR the split was exactly:
//
//   issues/…/comments  cursor[bot]  "## PR Summary <!-- CURSOR_SUMMARY --> ..."
//   pulls/…/comments   cursor[bot]  "Reasoning read from wrong field · Medium"
//
// so the endpoint IS the distinction; no body-sniffing needed. Costs nothing to
// get wrong in the safe direction either: with only $cmt1-6 to spend, a dropped
// summary frees a slot for something actionable.
const TOP_LEVEL_NOISE_AUTHORS = new Set([
  "cursor[bot]",              // "## PR Summary" — the same review it already left inline
  "shortcut-integration[bot]", // "This pull request has been linked to Shortcut Story #..."
]);

export async function fetchComments(repo: string, prNumber: number): Promise<RawComment[]> {
  const out: RawComment[] = [];
  const endpoints: { path: string; topLevel: boolean }[] = [
    { path: `repos/${repo}/pulls/${prNumber}/comments`, topLevel: false },
    { path: `repos/${repo}/issues/${prNumber}/comments`, topLevel: true },
  ];
  for (const { path: ep, topLevel } of endpoints) {
    try {
      const { stdout } = await execFileP(
        GH,
        ["api", `${ep}?per_page=50`, "--jq",
         '.[] | {id: (.id|tostring), author: .user.login, body: .body, url: .html_url, created: .created_at}'],
        { timeout: 10_000, maxBuffer: 8 << 20 }
      );
      for (const line of stdout.trim().split("\n")) {
        if (!line) continue;
        const c = JSON.parse(line) as RawComment;
        if (topLevel && TOP_LEVEL_NOISE_AUTHORS.has(c.author)) continue;
        out.push(c);
      }
    } catch {
      /* one endpoint failing shouldn't lose the other */
    }
  }
  // Drop resolved threads: a comment you have already dealt with is noise in a
  // sidebar row, and it costs a summarisation slot ($cmt1-6 is only six deep).
  const resolved = await resolvedCommentIds(repo, prNumber);
  const kept = resolved.size ? out.filter((c) => !resolved.has(String(c.id))) : out;
  kept.sort((a, b) => String((b as any).created).localeCompare(String((a as any).created)));
  return kept;
}

// ── summarising, via the summarize-pr-comment skill ─────────────────────────
//
// The daemon cannot "invoke a skill" — a skill is a set of instructions for an
// agent, so summarising means shelling out to headless Claude Code and letting
// it load ~/.claude/skills/summarize-pr-comment. That costs real latency and
// real tokens, which is why the cache below is not an optimisation but the
// thing that makes this viable at a 30s poll: a comment's text never changes,
// so each comment id is summarised EXACTLY ONCE, ever, across daemon restarts.
// A cold PR with 12 comments pays once; every later cycle is a file read.
const CACHE_PATH = path.join(HOME, ".local/state/herdr/comment-summaries.json");
const SUMMARY_TIMEOUT_MS = 120_000;

type Cache = Record<string, { emoji: string; subject: string } | null>;

function loadCache(): Cache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as Cache;
  } catch {
    return {};
  }
}

function saveCache(cache: Cache): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
    /* cache is a nicety; losing it costs re-summarisation, not correctness */
  }
}

// A `null` cache entry is a real answer, not a miss: it records "the skill
// looked at this comment and judged it noise" (a CI echo, a bare LGTM). Without
// it, every cycle would re-ask about the same worthless bot comment forever.
export async function summarizeComments(raw: RawComment[]): Promise<CommentSummary[]> {
  if (raw.length === 0) return [];
  const cache = loadCache();
  const unknown = raw.filter((c) => !(c.id in cache));

  if (unknown.length > 0) {
    const payload = JSON.stringify(
      unknown.map((c) => ({ id: c.id, author: c.author, body: c.body.slice(0, 4000) })),
      null,
      2
    );
    const prompt =
      "Use the summarize-pr-comment skill to summarise these GitHub pull request " +
      "review comments. Return only the JSON array described by that skill, with no " +
      "surrounding prose or code fence.\n\n" +
      payload;
    let parsed: CommentSummary[] = [];
    try {
      const { stdout } = await execFileP("claude", ["-p", prompt], {
        timeout: SUMMARY_TIMEOUT_MS,
        maxBuffer: 8 << 20,
      });
      // Headless Claude is asked for bare JSON but a stray fence is cheap to
      // survive, so take the outermost [...] rather than trusting the whole body.
      const m = stdout.match(/\[[\s\S]*\]/);
      if (m) parsed = JSON.parse(m[0]);
    } catch {
      parsed = []; // timeout, not installed, or unparseable — fall through
    }

    const bySeen = new Map(parsed.map((p) => [String(p.id), p]));
    for (const c of unknown) {
      const hit = bySeen.get(c.id);
      // Only record a decision when the summariser actually ran and returned
      // something for this batch. If the whole call failed, leave the ids out of
      // the cache so the next cycle retries instead of caching a fake "noise".
      if (hit) cache[c.id] = { emoji: hit.emoji, subject: hit.subject };
      else if (parsed.length > 0) cache[c.id] = null;
    }
    saveCache(cache);
  }

  const out: CommentSummary[] = [];
  for (const c of raw) {
    const hit = cache[c.id];
    if (hit) out.push({ id: c.id, emoji: hit.emoji, subject: hit.subject, url: c.url });
  }
  return out;
}

// ── the popup menu's link list ──────────────────────────────────────────────
//
// Everything the sidebar wants to be clickable but cannot be. Herdr strips
// control bytes from metadata, so a sidebar row can never carry an OSC 8
// hyperlink — but a Herdr POPUP is a real terminal, and OSC 8 works there
// normally. So the strip stays a status display and this list, rendered into a
// popup, is where cmd-click lives.
//
// Written to disk by the daemon rather than resolved when the popup opens: the
// popup has to feel instant, and every one of these is already known by the
// cycle that painted the glyph. It also guarantees the menu and the glyphs agree
// — they are built from the same snapshot.

export interface SpaceLink {
  glyph: string;
  label: string;
  url: string;
  color: string; // #rrggbb for the glyph, matching the sidebar's palette so the
                 // menu and the strip read as the same system
}

// Same hues as the $-token styles in config.toml. Duplicated rather than
// imported because the config is TOML that Herdr owns; if you retheme the
// sidebar, retheme here too.
const C = {
  red: "#ff6188",
  yellow: "#f9e2af",
  green: "#a6e3a1",
  grey: "#6c7086",
  mauve: "#cba6f7",
  purple: "#8957e0",
  cyan: "#89dceb",
  white: "#ffffff",
} as const;

function ciColor(status: CiStatus): string {
  if (isFailing(status)) return C.red;
  if (status === "running" || status === "on_hold") return C.yellow;
  if (status === "success") return C.green;
  return C.grey;
}

function tierColor(tier: ScTier | undefined): string {
  switch (tier) {
    case "idle": return C.grey;
    case "qa": return C.yellow;
    case "ship": return C.green;
    case "done": return C.purple;
    default: return C.cyan;
  }
}

export interface SpaceSidecar {
  name: string;
  branch: string;
  path: string;
  links: SpaceLink[];
}

export function buildLinks(i: SpaceInput, slug: string | null): SpaceLink[] {
  const links: SpaceLink[] = [];

  // Same exclusion the sidebar makes for the repo's main checkout: whatever PR
  // happens to have `master` as its head is not this Space's PR, and its review
  // comments are not yours. CI and the diff are still real, so they stay.
  if (i.pr.url && !i.isMain) {
    links.push({
      glyph: i.pr.merged ? MERGED_GLYPH : GIT_GLYPH,
      label: i.pr.merged
        ? `Pull request #${i.pr.number} (merged)`
        : `Pull request #${i.pr.number} — ${i.pr.approvals}/${APPROVALS_NEEDED} approved`,
      url: i.pr.url,
      color: i.pr.merged ? C.purple : C.mauve,
    });
  }

  if (i.ci?.url) {
    const n = i.ci.failedJobs?.length ?? 0;
    links.push({
      glyph: CI_GLYPH,
      label: `CircleCI — ${isFailing(i.ci.status) ? `${n} failing` : i.ci.status}`,
      url: i.ci.url,
      color: ciColor(i.ci.status),
    });
  } else if (slug) {
    // No pipeline resolved (never ran, or the token could not see it). The
    // branch page still exists and is where you'd go to find out why.
    links.push({
      glyph: CI_GLYPH,
      label: "CircleCI — branch pipelines",
      url: `https://app.circleci.com/pipelines/${slug}?branch=${encodeURIComponent(i.branch)}`,
      color: C.grey,
    });
  }

  const sid = shortcutId(i.branch);
  if (sid) {
    links.push({
      glyph: SC_GLYPH,
      label: `Shortcut sc-${sid}${i.scTier ? ` (${i.scTier})` : ""}`,
      url: `https://app.shortcut.com/popmenu/story/${sid}`,
      color: tierColor(i.scTier),
    });
  }

  links.push({
    glyph: DIFF_GLYPH,
    label: "Diff in Hubdiff",
    url: `hubdiff://?repo=${encodeURIComponent(i.path)}`,
    color: C.white,
  });

  // Failing jobs and comments are the two things the sidebar shows as text but
  // cannot link. In the popup they are the whole point: each one drills to the
  // job page or the exact comment.
  for (const j of i.ci?.failedJobs ?? []) {
    links.push({ glyph: JOB_PREFIX, label: j.name, url: j.url, color: C.red });
  }
  for (const c of i.isMain ? [] : i.comments) {
    // The emoji carries its own colour; the row is tinted mauve so the label
    // still reads as a link rather than as body text.
    links.push({ glyph: c.emoji, label: c.subject, url: c.url, color: C.mauve });
  }

  return links;
}

// ── Shortcut tiers ──────────────────────────────────────────────────────────
//
// Ported from cursor-status.ts, including the reason it matches on state NAME
// before Shortcut's coarse `type`: "In Development", "Ready for QA", "In QA",
// "Ready for Merge" and "Ready for Deploy" are ALL type=started in the Delivery
// workflow, so type alone would collapse the entire middle of the pipeline into
// one colour. Names (not positions) so it also works across the Discovery and
// Data workflows, which order their states differently.
const SHORTCUT_TOKEN = process.env.SHORTCUT_RO_TOKEN;
const SHORTCUT_API = "https://api.app.shortcut.com/api/v3";

function bucketTier(name: string, type: string): ScTier {
  const n = name.trim().toLowerCase();
  if (/ready for (merge|deploy|approval)/.test(n)) return "ship";
  if (/\bqa\b/.test(n)) return "qa";
  if (type === "done") return "done";
  if (type === "backlog" || type === "unstarted") return "idle";
  return "active";
}

async function scApi<T>(p: string): Promise<T> {
  const res = await fetch(`${SHORTCUT_API}${p}`, {
    headers: { "Shortcut-Token": SHORTCUT_TOKEN as string },
  });
  if (!res.ok) throw new Error(`${p} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// workflow-state id → tier. Workspace configuration, so it is fetched once per
// process and never refreshed: these states change about once a year, and the
// daemon restarts more often than that.
let stateTiers: Map<number, ScTier> | null = null;

async function loadStateTiers(): Promise<Map<number, ScTier>> {
  if (stateTiers) return stateTiers;
  const workflows = await scApi<{ states: { id: number; name: string; type: string }[] }[]>("/workflows");
  const map = new Map<number, ScTier>();
  for (const w of workflows) for (const s of w.states) map.set(s.id, bucketTier(s.name, s.type));
  stateTiers = map;
  return map;
}

// Tier for each branch that carries an sc-<id>. Without SHORTCUT_RO_TOKEN this
// returns empty and every ◆ falls back to neutral cyan — the glyph still shows,
// it just stops claiming to know where the story sits.
export async function shortcutTiers(branches: string[]): Promise<Map<string, ScTier>> {
  const out = new Map<string, ScTier>();
  if (!SHORTCUT_TOKEN) return out;

  const wanted = branches
    .map((b) => ({ branch: b, id: shortcutId(b) }))
    .filter((x): x is { branch: string; id: string } => Boolean(x.id));
  if (wanted.length === 0) return out;

  let tiers: Map<number, ScTier>;
  try {
    tiers = await loadStateTiers();
  } catch {
    return out;
  }

  // One request per distinct story. Two worktrees can carry the same sc- id
  // (a spike branch and its real branch), so dedupe before fetching.
  const byId = new Map<string, string[]>();
  for (const { branch, id } of wanted) {
    byId.set(id, [...(byId.get(id) ?? []), branch]);
  }
  await Promise.all(
    [...byId.entries()].map(async ([id, brs]) => {
      try {
        const story = await scApi<{ workflow_state_id: number }>(`/stories/${id}`);
        const tier = tiers.get(story.workflow_state_id);
        if (tier) for (const b of brs) out.set(b, tier);
      } catch {
        /* deleted story, or an id that was never a story — leave it neutral */
      }
    })
  );
  return out;
}
