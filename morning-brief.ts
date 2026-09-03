#!/usr/bin/env -S npx tsx
/**
 * morning-brief — the overnight delta, rendered once and read once.
 *
 * The other panels in this dashboard answer "what is true right now" and repaint
 * forever. This one answers a different question: WHAT CHANGED WHILE I WAS GONE.
 * That difference drives every design decision below.
 *
 *   - It is a one-shot script, not a poll loop. It runs, prints, exits.
 *   - It is generated on a schedule (launchd, 06:00) and DISPLAYED on attach,
 *     because those are not the same moment. See morning-brief.plist.
 *   - Everything is scoped to a WINDOW (default: 3pm the previous weekday →
 *     now), not to "currently open". A PR that has been waiting four days is
 *     already visible in the git-notiql pane all day; repeating it here would
 *     make the brief a second copy of a panel you already have.
 *
 * SECTIONS
 *   REVIEWS  the 🤝 category from git-notiql.ts — tickets in your team's Shortcut
 *            "Ready for Review" or "In Development" columns — narrowed to the ones
 *            actually WAITING ON YOU: either you have never filed a review, or you
 *            filed one and the author re-requested you. Not windowed, unlike every
 *            other section: a review you owe from Monday is still owed on Friday.
 *            See the long note above fetchTeamReviewBadges
 *            in git-notiql.ts for why this comes from Shortcut and not from a
 *            GitHub search: the GitHub framings return 65-150 PRs, this returns 4.
 *   AGENDA   today's calendar as a timeline, from the same EventKit binary the
 *            status strip uses (`bin/nextmeeting --agenda`). Rendered with the
 *            GAPS in it, because "four meetings" and "four meetings, all before
 *            1pm" are different days.
 *   SENTRY   the team's OWN Sentry queue — `assigned:#marketeers` inside the two
 *            projects it owns — as ONE ranked list, not four thresholded
 *            categories. Each row is tagged with the most alarming true thing
 *            about it (REGRESS / NEW / SPIKE / ·), a ⛔n marker counting events
 *            that exhausted their Sidekiq retries, a ↩team hint when the code
 *            looks like another team's product area (ADVICE ONLY — this script
 *            never calls Sentry's assignment API), and carries its direction
 *            against a 13-day median. Issues nobody on the team owns are out of
 *            scope by design; see SENTRY_TEAM.
 *
 * USAGE
 *   ./morning-brief.ts              fetch live, print to stdout
 *   ./morning-brief.ts --write      fetch, write today's brief to the cache dir
 *   ./morning-brief.ts --cached     print today's cached brief (generating it if
 *                                   it isn't there yet) — what the popup runs
 *   ./morning-brief.ts --json       raw gathered data, no rendering (for debugging
 *                                   a section that looks wrong without re-reading
 *                                   ANSI soup)
 *
 * ENV
 *   SHORTCUT_RO_TOKEN   drives the REVIEWS section  (absent → section skipped)
 *
 * MODES:
 *   (none)     render to stdout at the terminal's width; touches no cache
 *   --write    render at BRIEF_WIDTH and cache it — what launchd runs at 06:00
 *   --cached   print today's cached copy verbatim; generates only if none exists
 *   --fresh    ignore every cache, regenerate summaries and all, then cache it
 *   --json     the raw section data, for debugging a row that looks wrong
 *   GITHUB_TOKEN        enriches it with PR detail  (absent → section skipped)
 *   SENTRY_AUTH_TOKEN   drives the SENTRY section   (absent → section skipped)
 *   A missing token degrades ONE section and says so in place. It never takes
 *   the brief down — a brief that refuses to print because Sentry is unreachable
 *   is worse than a brief with a hole in it.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const SHORTCUT_TOKEN = process.env.SHORTCUT_RO_TOKEN;
const SENTRY_TOKEN = process.env.SENTRY_AUTH_TOKEN;

const GRAPHQL_URL = "https://api.github.com/graphql";
const SHORTCUT_API = "https://api.app.shortcut.com/api/v3";

// Sentry's US region host. sentry.io/api/0 works for the org LIST but issue
// queries must go to the org's regionUrl, which for popmenu is us.sentry.io.
const SENTRY_API = "https://us.sentry.io/api/0";
const SENTRY_ORG = "popmenu";

// Same team/column/branch config as git-notiql.ts — deliberately duplicated
// rather than imported, because that file is a long-lived poll loop with a
// module-level cache and importing it would start paying for machinery this
// one-shot script never uses.
const SC_TEAM_NAME = "Marketeers";

// Plural, and matched across EVERY workflow rather than stopping at the first
// hit — see the matching block in git-notiql.ts for the full reasoning. Short
// version: "In Development" is included because opening a PR and dragging the
// ticket are two separate acts and people do the first without the second, and
// the workspace has two distinct states that trim to "Ready for Review" (the
// Data workflow's has a trailing space), so first-match-wins picks one at
// random and looks correct while doing it.
const SC_REVIEW_STATE_NAMES = ["Ready for Review", "In Development"];
const MY_BRANCH_PREFIX = "steele/";
const MY_LOGIN = "colintsteele";

// The window. 3pm is when you stop reading review requests; the brief picks up
// where that left off.
const WINDOW_HOUR = 15;

// ...and it walks back to the previous WEEKDAY, not the previous day. Monday's
// brief has to cover Friday 3pm onward or the whole weekend falls in a gap that
// nothing else reports on. Tue-Fri this is just "yesterday at 3pm".
function windowStart(now: Date): Date {
  const d = new Date(now);
  d.setHours(WINDOW_HOUR, 0, 0, 0);
  do {
    d.setDate(d.getDate() - 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return d;
}

// Sentry is scoped twice, and BOTH scopes are load-bearing:
//   1. to the projects the team owns — resolved from Sentry at runtime. Not an
//      optimization: an org-wide issue query across all 30 popmenu projects is
//      rejected outright with "Rate limit exceeded ... try fewer projects".
//   2. to `assigned:#<team>` — because an issue nobody on the team owns is not
//      this brief's business. Everything here is the team's queue.
const SENTRY_TEAM = "marketeers";

// One pool, not four. This section used to run four independent queries — new,
// regressed, spiking, high-reach — each with thresholds calibrated against
// org-wide traffic. Under team scoping that was simply wrong: the whole team
// pool is ~14 issues topping out at 18 events and 2 users in 24h, so a 50-event
// spike floor and a 250-user reach floor could NEVER fire. Two of the four rules
// were dead code that read like coverage.
//
// So: fetch the team's queue once, rank it, and tag each row with whatever is
// true of it. Nothing the team owns can fall through, because there is no
// threshold left to fall through.
const SENTRY_WINDOW_HOURS = 24 * 7;

// A row is worth shouting about when it is moving. Calibrated to THIS pool, not
// to the firehose: at a 50-event floor nothing the team owns would ever qualify.
const SPIKE_MIN_EVENTS = 8;
const SPIKE_MIN_RATIO = 3;

// Sidekiq stamps every error event with `sidekiq_final_retry`, and the value is
// Ruby-cased: "True" / "False" / "" — `sidekiq_final_retry:true` is a valid query
// that silently matches NOTHING. The capital is load-bearing.
//
// A True event means the job exhausted its retries and will never run again:
// that work is gone. Every other signal in this section is a symptom; this one
// is confirmed damage, which is why it outranks NEW and SPIKE below.
const SIDEKIQ_FINAL_RETRY_TAG = "sidekiq_final_retry";

// ---- suggested reassignment ----
// Marks a row whose CODE belongs to another team's product area. It only ever
// suggests: nothing here calls Sentry's assignment API, and it must not. Use the
// `sentry-assignment` skill to decide, and reassign by hand.
//
// Three iterations, each killed by a measured false positive:
//
// 1. Regex the ownership doc's product areas. Both hits on the real queue were
//    wrong: `SocialPost::LivePost::SnapshotAll` matched "snapshot" -> Phoenix
//    ("Weekly Snapshot Email") when it is Social Posting, and
//    `OpenTableSync::ReservationsSync` matched "reservation" -> Phoenix when
//    OpenTable Integration is explicitly Marketeers. Generic English in the doc
//    collides with ordinary code vocabulary. Vocabulary cut to vendor and
//    namespace tokens only.
//
// 2. Match the CULPRIT only. Silent on the one issue that actually warranted a
//    move — ZRY's culprit is `ConsumerController#fallback`, and the evidence
//    (`app/policies/custom_page/section_column_policy.rb`) is in the stack.
//    Now matches in-app frame paths too, minus the shared ones.
//
// 3. Flatten punctuation, then regex. `query_extension` flattens to
//    `queryextension`, which CONTAINS "yext", so a MessageCampaign job was
//    recommended to Phoenix. \b cannot save you once the separators are gone.
//    Normalisation now splits camelCase and turns punctuation into SPACES, so
//    word boundaries survive and every pattern is \b-anchored.
//
// Ambiguous areas (SMS, DoorDash, Offers, Menu/Order Management) are deliberately
// ABSENT: only a stack trace settles those, which is the skill's job.
const OWNERSHIP_HINTS: [string, RegExp][] = [
  ["air-fried-steak", /\b(chargebee|salesforce)\b/],
  ["nsync", /\b(clover|deliverect|spoton|toast|micros|aloha|square|pos error|gift card|loyalty)\b/],
  ["phoenix", /\b(yext|authy|gbp|gmb|google business|waitlist)\b/],
  ["revenge-of-the-nerds", /\b(ordernerd|grubhub|postmates)\b/],
  ["the-a-team", /\b(woflow|custom page|print center|doordash drive|uber direct|gallery image)\b/],
  ["pal9000", /\b(ai answering)\b/],
  ["marketeers", /\b(open table|message campaign|social post|social account|follower segment)\b/],
];

// Frames every issue passes through. Matching them would route on the plumbing
// rather than the product — and worse, would make the whole NilClassPolicy family
// look like one team's problem for the wrong reason. See the shared-infrastructure
// trap in the sentry-assignment skill.
const SHARED_FRAMES = /application_policy|service_object|application_record|application_controller|\/concerns\/|middleware/;

// `CustomPage::PublishDrafts` and `custom_page/section_column_policy.rb` must both
// reduce to `custom page ...`, so: split camelCase FIRST, then punctuation to
// spaces. Spaces, never deletion — see iteration 3 above.
function normalizeForRouting(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function suggestedTeam(issue: SentryIssue, frames: string[]): string | null {
  const parts = [issue.culprit ?? "", issue.title, ...frames.filter((f) => !SHARED_FRAMES.test(f))];
  const hay = parts.map(normalizeForRouting).join(" ");
  for (const [team, pattern] of OWNERSHIP_HINTS) {
    if (pattern.test(hay)) return team === SENTRY_TEAM ? null : team;
  }
  return null;
}

// Everything cached on disk lives here: the rendered brief, the seen marker
// termdash writes, and the summary cache below. Declared before its first use —
// it is read at module load by SUMMARY_CACHE.
const CACHE_DIR = path.join(os.homedir(), ".cache", "termdash");

// ---- one-line summaries ----
// A Sentry title is mostly boilerplate: "ActiveRecord::QueryCanceled:
// PG::QueryCanceled: ERROR: canceling statement due to statement timeout" spends
// 60 characters saying "a query timed out" and then gets truncated before it
// says WHERE. Rows were unreadable at any width.
//
// So each issue gets a short plain-English summary, generated once by `claude -p`
// and cached on disk forever after. Keyed on title+culprit, so an issue whose
// error changes gets re-summarised and one that does not never costs a second
// call. Steady state after the first run is zero LLM calls.
//
// Degrades to the raw title if `claude` is missing, unauthenticated, slow, or
// returns junk — the brief must never fail to print because a nicety failed.
const SUMMARY_CACHE = path.join(CACHE_DIR, "sentry-summaries.json");
const SUMMARY_MAX = 46;
const SUMMARY_TIMEOUT_MS = 120_000;
const SUMMARIES_ENABLED = process.env.TERMDASH_NO_LLM !== "1";

// --fresh answers "what would this look like if nothing had been generated yet".
// That means the summary cache has to be IGNORED on read, not deleted: every
// issue on screen gets re-summarised from scratch, and the results are written
// back so the next ordinary run is cheap again. Deleting it would throw away the
// summaries for issues that are not in today's window and cannot be regenerated
// without them showing up again.
let IGNORE_SUMMARY_CACHE = false;

interface SummaryEntry {
  key: string; // title+culprit at generation time; a change invalidates the entry
  summary: string;
  at: string;
}

function summaryKey(i: SentryIssue): string {
  return `${i.title}|${i.culprit ?? ""}`;
}

function loadSummaries(): Record<string, SummaryEntry> {
  try {
    return JSON.parse(fs.readFileSync(SUMMARY_CACHE, "utf8")) as Record<string, SummaryEntry>;
  } catch {
    return {};
  }
}

async function ensureSummaries(issues: SentryIssue[]): Promise<Map<string, string>> {
  const cache = loadSummaries();
  const out = new Map<string, string>();
  const missing: SentryIssue[] = [];

  for (const i of issues) {
    const hit = IGNORE_SUMMARY_CACHE ? undefined : cache[i.id];
    if (hit && hit.key === summaryKey(i)) out.set(i.id, hit.summary);
    else missing.push(i);
  }
  if (!missing.length || !SUMMARIES_ENABLED) return out;

  const prompt = [
    `Summarise each Sentry issue in one line of plain English: what is broken, and where.`,
    ``,
    `Rules:`,
    `- Hard limit ${SUMMARY_MAX} characters. Shorter is better.`,
    `- Name the SUBSYSTEM and the FAILURE. "OpenTable guest sync timing out", not "UnhandledError".`,
    `- Drop the exception class unless the class is the meaning (a timeout, a deadlock).`,
    `- The culprit is the best clue to the subsystem. Use it.`,
    `- Sentence case. No trailing period, no emoji, no quotes.`,
    ``,
    `Return ONLY a JSON object mapping id to summary, no prose and no code fence.`,
    ``,
    ...missing.map((i) => `${i.id} | ${i.title} | ${i.culprit ?? ""}`),
  ].join("\n");

  let raw: string;
  try {
    // cwd is a temp dir on purpose: run from this repo and the CLI loads the
    // project's settings and skills, which costs startup time and context for a
    // task that needs neither.
    raw = execFileSync("claude", ["-p", prompt], {
      encoding: "utf8",
      timeout: SUMMARY_TIMEOUT_MS,
      cwd: os.tmpdir(),
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return out; // fall back to raw titles for the whole batch
  }

  let parsed: Record<string, string>;
  try {
    // Tolerate a stray code fence or a sentence before the JSON.
    const m = raw.match(/\{[\s\S]*\}/);
    parsed = m ? (JSON.parse(m[0]) as Record<string, string>) : {};
  } catch {
    return out;
  }

  const now = new Date().toISOString();
  for (const i of missing) {
    const s = (parsed[i.id] ?? "").trim();
    if (!s) continue;
    const clean = trunc(s, SUMMARY_MAX);
    out.set(i.id, clean);
    cache[i.id] = { key: summaryKey(i), summary: clean, at: now };
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(SUMMARY_CACHE, JSON.stringify(cache, null, 2));
  } catch {
    /* a cache we could not write just means we regenerate next time */
  }
  return out;
}

// Trend bands. Inside these the day is normal and the row says "steady".
const TREND_UP = 1.25;
const TREND_DOWN = 0.75;

// Per-section display caps. Overflow is COUNTED, never silently dropped — a
// brief that truncates without saying so reads as "that's all there was".
const MAX_ROWS = 10;


// ---------------------------------------------------------------------------
// ANSI — same vocabulary as local-status.ts / git-notiql.ts
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const BRIGHT_RED = "\x1b[91m";
const YELLOW = "\x1b[33m";
const ORANGE = "\x1b[38;5;208m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const GRAY = "\x1b[90m";

function link(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

// The brief is a CACHED ARTIFACT, so its width is decided when it is written
// and can never be re-decided when it is read. `--write` therefore always
// renders at BRIEF_WIDTH regardless of the terminal it happens to run in (under
// launchd there isn't one, and COLUMNS is unset). termdash then sizes the popup
// to match — see BRIEF_POPUP_W there, which is this number plus borders. That
// coupling is what makes the brief look centered: a fixed-width block inside a
// 90%-wide popup is a fixed-width block shoved against the left border.
// 130, not 80-and-hope. The Sentry rows carry five fields plus a title plus a
// disambiguating culprit, and at 100 columns two OpenTable rows collapsed into
// "OpenTable::Sync:… · OpenTableSync::GuestsSy…" — technically distinct, useless
// to read. The dashboard window is 212 columns; spending 130 of them on the one
// artifact you read once a day is cheap. Popups are clamped to the client width,
// so this degrades rather than breaks on a narrow screen.
const BRIEF_WIDTH = 130;

// Not a const: --write pins it below. Direct-to-stdout runs still follow the
// terminal, which is what you want when you are iterating on a section.
let WIDTH = Math.max(60, Math.min(Number(process.env.COLUMNS) || BRIEF_WIDTH, 120));

// Truncation has to count VISIBLE characters, so it runs on plain text before
// any coloring or OSC-8 wrapping — same rule as the status strip's centering.
function trunc(s: string, n: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length <= n ? clean : clean.slice(0, n - 1) + "…";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

// "13:31" for today, "Tue 16:02" for anything earlier — the weekday is the only
// thing you actually need to disambiguate inside a window this short.
function stamp(iso: string, now: Date): string {
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${hm}`;
}

// ---------------------------------------------------------------------------
// REVIEWS — Shortcut queue → GitHub PR detail
// ---------------------------------------------------------------------------

interface ScStory {
  id: number;
  archived: boolean;
  name: string;
}

interface ScPullRequest {
  number: number;
  url: string;
  branch_name?: string;
  review_status?: string;
  merged?: boolean;
  closed?: boolean;
  draft?: boolean;
}

interface ReviewRow {
  number: number;
  url: string;
  title: string;
  author: string;
  storyId: number;
  readyAt: string; // when it became reviewable — see prReadyAt
  approvedByMe: boolean;
  touchedByMe: boolean; // commented, but never submitted a formal review
  approvedByOthers: boolean;
  requestedOfMe: boolean; // I am currently a requested reviewer
  reReview: boolean; // I reviewed once already and it has come back to me
}

async function shortcut<T>(p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SHORTCUT_API}${p}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Shortcut-Token": SHORTCUT_TOKEN as string,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`shortcut ${p} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function graphql<T>(query: string): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`graphql -> ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`graphql: ${json.errors[0].message}`);
  return json.data as T;
}

// A PR "went up" at the later of: when it was opened, and when it last left
// draft. Using createdAt alone misses the common case of a PR opened as a draft
// on Monday and marked ready on Thursday afternoon — which is exactly a review
// request that went up inside the window.
function prReadyAt(pr: { createdAt: string; timelineItems: { nodes: { createdAt?: string }[] } }): string {
  const ready = pr.timelineItems.nodes.filter((n) => n.createdAt).map((n) => n.createdAt as string);
  if (!ready.length) return pr.createdAt;
  const latest = ready.sort().at(-1) as string;
  return latest > pr.createdAt ? latest : pr.createdAt;
}

async function fetchReviews(): Promise<{ rows: ReviewRow[]; note?: string }> {
  if (!SHORTCUT_TOKEN) return { rows: [], note: "SHORTCUT_RO_TOKEN not set" };
  if (!GITHUB_TOKEN) return { rows: [], note: "GITHUB_TOKEN not set" };

  const groups = await shortcut<{ id: string; name: string; archived: boolean }[]>("/groups");
  const group = groups.find((g) => !g.archived && g.name === SC_TEAM_NAME);
  if (!group) return { rows: [], note: `no Shortcut team "${SC_TEAM_NAME}"` };

  const workflows = await shortcut<{ states: { id: number; name: string }[] }[]>("/workflows");
  const stateIds = workflows.flatMap((w) =>
    w.states.filter((s) => SC_REVIEW_STATE_NAMES.includes(s.name.trim())).map((s) => s.id),
  );
  if (!stateIds.length) return { rows: [], note: `no Shortcut states ${SC_REVIEW_STATE_NAMES.join(", ")}` };

  // One search per state — the endpoint takes a single workflow_state_id — then
  // deduped by story id.
  const perState = await Promise.all(
    stateIds.map((id) => shortcut<ScStory[]>("/stories/search", { group_id: group.id, workflow_state_id: id })),
  );
  const byId = new Map<number, ScStory>();
  for (const s of perState.flat()) byId.set(s.id, s);

  // archived is not optional: the Shortcut UI hides archived stories, so a raw
  // group+state search returns a pile of long-dead tickets that are not in the
  // column you are looking at.
  const live = [...byId.values()].filter((s) => !s.archived);

  const candidates: { storyId: number; owner: string; repo: string; number: number }[] = [];
  const seen = new Set<number>(); // one story's PR can be attached to another's
  for (const story of live) {
    const detail = await shortcut<{ pull_requests?: ScPullRequest[] }>(`/stories/${story.id}`);
    for (const pr of detail.pull_requests ?? []) {
      if (pr.merged || pr.closed || pr.draft) continue;
      if (pr.branch_name?.startsWith(MY_BRANCH_PREFIX)) continue; // your own work
      if (seen.has(pr.number)) continue;
      const m = pr.url?.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (!m) continue;
      seen.add(pr.number);
      candidates.push({ storyId: story.id, owner: m[1], repo: m[2], number: Number(m[3]) });
    }
  }
  if (!candidates.length) return { rows: [] };

  // One aliased GraphQL call for every candidate — 1 rate-limit point each,
  // and a handful of candidates is the normal case.
  //
  // `reviews(author: MY_LOGIN)` is doing double duty. It is how "I approved
  // this" is decided, and it is most of how "I touched this" is decided:
  // replying in a review thread produces a PullRequestReview with state
  // COMMENTED, so thread activity shows up here without walking reviewThreads
  // (which would cost far more). The gap is a bare top-level comment, which is
  // why `comments` is fetched too.
  const frag = `
    number title url createdAt
    author { login }
    reviewDecision
    timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT], last: 1) {
      nodes { ... on ReadyForReviewEvent { createdAt } }
    }
    reviews(first: 20, author: "${MY_LOGIN}") { nodes { state submittedAt } }
    comments(last: 50) { nodes { author { login } } }
    reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
  `;
  const query = `query {
    ${candidates
      .map(
        (c, i) =>
          `p${i}: repository(owner: "${c.owner}", name: "${c.repo}") { pullRequest(number: ${c.number}) { ${frag} } }`,
      )
      .join("\n")}
  }`;

  type GqlPr = {
    number: number;
    title: string;
    url: string;
    createdAt: string;
    author: { login: string } | null;
    reviewDecision: string | null;
    timelineItems: { nodes: { createdAt?: string }[] };
    reviews: { nodes: { state: string; submittedAt: string | null }[] };
    comments: { nodes: { author: { login: string } | null }[] };
    reviewRequests: { nodes: { requestedReviewer: { login?: string } | null }[] };
  };

  const data = await graphql<Record<string, { pullRequest: GqlPr | null }>>(query);

  const rows: ReviewRow[] = [];

  candidates.forEach((c, i) => {
    const pr = data[`p${i}`]?.pullRequest;
    if (!pr) return;

    // "I approved it" means my LATEST review is an approval. An old APPROVED
    // followed by a later CHANGES_REQUESTED is not an approval, and the reverse
    // ordering is the ordinary re-review flow.
    const mine = pr.reviews.nodes.filter((r) => r.submittedAt).sort((a, b) => (a.submittedAt! < b.submittedAt! ? -1 : 1));
    const latest = mine.at(-1);
    const approvedByMe = latest?.state === "APPROVED";

    // GitHub drops you out of reviewRequests the moment you submit a review and
    // puts you back when the author re-requests, so "am I in this list" IS the
    // re-request signal — no timeline walking needed.
    //
    // User-only on purpose. A request aimed at a TEAM I belong to does not mean
    // the review is mine, and counting it would put every team-tagged PR in the
    // section. That is the noise this section exists to avoid.
    const requestedOfMe = pr.reviewRequests.nodes.some((n) => n.requestedReviewer?.login === MY_LOGIN);
    const neverReviewed = mine.length === 0;

    // THE WHOLE FILTER: the ball has to be in my court. Either I have never put
    // a review on this PR, or I have and it has been sent back to me.
    //
    // The interesting exclusion is the middle case — I reviewed, nobody
    // re-requested — which covers both "I approved" and "I requested changes and
    // am waiting on the author". Those are the author's move, not mine, and they
    // are what used to pad this section out.
    if (!neverReviewed && !requestedOfMe) return;

    const touchedByMe =
      neverReviewed && pr.comments.nodes.some((n) => n.author?.login === MY_LOGIN);

    // No window test. A PR I still owe a review on does not stop needing one
    // because it went up on Monday — see the note on the REVIEWS header.
    const readyAt = prReadyAt(pr);

    rows.push({
      number: pr.number,
      url: pr.url,
      title: pr.title,
      author: pr.author?.login ?? "?",
      storyId: c.storyId,
      readyAt,
      approvedByMe,
      touchedByMe,
      approvedByOthers: pr.reviewDecision === "APPROVED",
      requestedOfMe,
      reReview: !neverReviewed,
    });
  });

  rows.sort((a, b) => (a.readyAt < b.readyAt ? -1 : 1));

  return { rows };
}

// ---------------------------------------------------------------------------
// AGENDA — today's calendar, via the same EventKit helper the status strip uses
// ---------------------------------------------------------------------------

interface Meeting {
  title: string;
  start: string;
  end: string;
  minutes_until: number;
  in_progress: boolean;
  all_day: boolean;
  location: string | null;
  join_url: string | null;
  calendar: string;
}

interface AgendaReport {
  access: string;
  error: string | null;
  day: string;
  events: Meeting[];
}

const NEXTMEETING_BIN = path.join(__dirname, "bin", "nextmeeting");

function fetchAgenda(): { events: Meeting[]; note?: string } {
  if (!fs.existsSync(NEXTMEETING_BIN)) return { events: [], note: "bin/nextmeeting not built — run ./build-nextmeeting.sh" };
  let raw: string;
  try {
    // execFileSync, not a shell: the binary is a one-shot that always exits, and
    // its EventKit permission prompt is already resolved because the status
    // strip has been calling it every 5s all week.
    raw = execFileSync(NEXTMEETING_BIN, ["--agenda"], { encoding: "utf8", timeout: 15_000 });
  } catch (e) {
    return { events: [], note: `nextmeeting: ${(e as Error).message}` };
  }
  let report: AgendaReport;
  try {
    report = JSON.parse(raw);
  } catch {
    return { events: [], note: "nextmeeting: unparseable output" };
  }
  if (report.access !== "granted") return { events: [], note: `calendar ${report.access}${report.error ? ` — ${report.error}` : ""}` };
  if (report.error) return { events: [], note: report.error };
  return { events: report.events };
}

// ---------------------------------------------------------------------------
// SENTRY
// ---------------------------------------------------------------------------

interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  level: string;
  count: string | number;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  isUnhandled: boolean;
  substatus?: string;
  project: { slug: string };
  stats?: Record<string, [number, number][]>;
  // Whatever the org's integrations have linked to this issue. The Shortcut
  // integration puts the story URL here, and it rides along on the ISSUE LIST
  // response — so the sc- column costs no extra request.
  annotations?: { url?: string; displayName?: string }[];
}


// The team's projects, resolved once per run. See the SENTRY_TEAM comment for
// why every issue query has to carry these ids.
let sentryProjectIds: string[] | null = null;

async function sentryTeamProjects(): Promise<string[]> {
  if (sentryProjectIds) return sentryProjectIds;
  const res = await fetch(`${SENTRY_API}/teams/${SENTRY_ORG}/${SENTRY_TEAM}/projects/`, {
    headers: { Authorization: `Bearer ${SENTRY_TOKEN}` },
  });
  if (!res.ok) throw new Error(`sentry teams/${SENTRY_TEAM} -> ${res.status}`);
  const projects = (await res.json()) as { id: string }[];
  sentryProjectIds = projects.map((p) => p.id);
  return sentryProjectIds;
}

async function sentry(query: string, extra: Record<string, string> = {}): Promise<SentryIssue[]> {
  const url = new URL(`${SENTRY_API}/organizations/${SENTRY_ORG}/issues/`);
  url.searchParams.set("query", query);
  url.searchParams.set("statsPeriod", "24h");
  url.searchParams.set("sort", "freq");
  url.searchParams.set("limit", "100");
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  for (const id of await sentryTeamProjects()) url.searchParams.append("project", id);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${SENTRY_TOKEN}` } });
  if (!res.ok) throw new Error(`sentry ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error(`sentry: ${JSON.stringify(json).slice(0, 120)}`);
  return json as SentryIssue[];
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// One row per issue in the team's queue, carrying everything the renderer needs
// to tag it. `isNew` / `isRegressed` come from separate queries because Sentry
// decides both, and `ratio` is computed here because Sentry does not.
interface OwnedRow {
  issue: SentryIssue;
  baseline: number;
  ratio: number;
  isNew: boolean;
  isRegressed: boolean;
  finalRetries: number; // events in the last 24h that exhausted Sidekiq retries
  suggestedTeam: string | null; // another team's product area — advice only, never acted on
  summary: string; // short plain-English line; falls back to the raw Sentry title
}

// How many of an issue's last-24h events exhausted their Sidekiq retries.
//
// Neither obvious route works. `/issues/{id}/tags/{key}/` ignores statsPeriod
// entirely and reports LIFETIME counts, and adding `sidekiq_final_retry:True` to
// the issue search returns the issue's FULL event count, not the tagged subset —
// both would have reported 18 where the answer is 3. The events dataset is the
// only one that aggregates per issue, and it does the whole pool in one request.
//
// Pinned to explicit issue ids rather than paginating the org: the answer is a
// join against 14 known issues, and a page limit silently dropping one of them
// would look exactly like "this issue has no dead jobs".
async function fetchFinalRetries(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;

  const url = new URL(`${SENTRY_API}/organizations/${SENTRY_ORG}/events/`);
  url.searchParams.append("field", "issue.id");
  url.searchParams.append("field", "count()");
  url.searchParams.set("query", `${SIDEKIQ_FINAL_RETRY_TAG}:True issue.id:[${ids.slice(0, 100).join(",")}]`);
  url.searchParams.set("statsPeriod", "24h");
  url.searchParams.set("dataset", "errors");
  url.searchParams.set("per_page", "100");
  for (const id of await sentryTeamProjects()) url.searchParams.append("project", id);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${SENTRY_TOKEN}` } });
  // Non-fatal: a row with no glyph reads as "no dead jobs", which is the common
  // case, so a failure here degrades to the common case rather than to a lie
  // about something else.
  if (!res.ok) return out;
  const json = (await res.json()) as { data?: { "issue.id": number; "count()": number }[] };
  for (const row of json.data ?? []) out.set(String(row["issue.id"]), row["count()"]);
  return out;
}

// In-app stack frame paths for one issue's latest event. One request per issue,
// which is only affordable because this runs once a day over ~14 issues — do not
// copy this into a poll loop.
async function fetchFrames(issueId: string): Promise<string[]> {
  const res = await fetch(`${SENTRY_API}/issues/${issueId}/events/latest/`, {
    headers: { Authorization: `Bearer ${SENTRY_TOKEN}` },
  });
  if (!res.ok) return []; // no frames -> no suggestion, which is the safe default
  const json = (await res.json()) as {
    entries?: { type: string; data?: { values?: { stacktrace?: { frames?: { inApp?: boolean; filename?: string }[] } }[] } }[];
  };
  const out: string[] = [];
  for (const entry of json.entries ?? []) {
    if (entry.type !== "exception") continue;
    for (const v of entry.data?.values ?? []) {
      for (const f of v.stacktrace?.frames ?? []) {
        if (f.inApp && f.filename) out.push(f.filename);
      }
    }
  }
  return out;
}

// Used by BOTH the ranking and the row tag. They disagreed once; sharing the
// predicate is the only thing that stops it happening again.
function isSpike(r: OwnedRow): boolean {
  return Number(r.issue.count) >= SPIKE_MIN_EVENTS && r.ratio >= SPIKE_MIN_RATIO;
}

async function fetchSentry(now: Date): Promise<{ rows: OwnedRow[]; note?: string }> {
  if (!SENTRY_TOKEN) return { rows: [], note: "SENTRY_AUTH_TOKEN not set" };
  void now;

  const hours = SENTRY_WINDOW_HOURS;
  const team = `assigned:#${SENTRY_TEAM}`;

  // TRAP, documented because it cost an hour and looks like a bug in this file:
  // the `firstSeen` FIELD on a returned issue is window-relative — clamped to
  // statsPeriod — while the `firstSeen:` QUERY filter uses the true lifetime.
  // At statsPeriod=24h the OpenTable issues report firstSeen as yesterday while
  // `lifetime.firstSeen` says June, so reading the field would classify a
  // three-month-old error as new. Trust the query filter, never the field.
  //
  // `groupStatsPeriod: "14d"` on the pool query is what makes a baseline
  // possible: `statsPeriod` scopes the `count` field, `groupStatsPeriod` scopes
  // the daily series. Different knobs, both needed.
  const [pool, fresh, regressed] = await Promise.all([
    sentry(`is:unresolved ${team}`, { groupStatsPeriod: "14d" }),
    sentry(`is:unresolved ${team} firstSeen:-${hours}h`),
    sentry(`is:regressed ${team} lastSeen:-${hours}h`),
  ]);

  const newIds = new Set(fresh.map((i) => i.id));
  const regressedIds = new Set(regressed.map((i) => i.id));

  // A regressed issue is not always in the `is:unresolved` pool, so union rather
  // than intersect — otherwise the one category that means "we thought this was
  // fixed" is the one that can go missing.
  const byId = new Map<string, SentryIssue>();
  for (const i of [...pool, ...regressed]) byId.set(i.id, i);

  const live = [...byId.values()].filter((i) => Number(i.count) > 0);
  const [deadJobs, frameLists, summaries] = await Promise.all([
    fetchFinalRetries(live.map((i) => i.id)),
    Promise.all(live.map((i) => fetchFrames(i.id))),
    ensureSummaries(live),
  ]);

  const rows: OwnedRow[] = live
    .map((issue, idx) => {
      // Drop the final bucket: it is TODAY, still filling, and comparing a 24h
      // total against a partial day would manufacture a spike every morning.
      const series = (issue.stats?.["14d"] ?? []).slice(0, -1).map((b) => b[1]);
      // Median, not mean — one bad day two weeks ago should not raise the bar
      // that today has to clear.
      const baseline = median(series);
      return {
        issue,
        baseline,
        ratio: baseline > 0 ? Number(issue.count) / baseline : Infinity,
        isNew: newIds.has(issue.id),
        isRegressed: regressedIds.has(issue.id),
        finalRetries: deadJobs.get(issue.id) ?? 0,
        suggestedTeam: suggestedTeam(issue, frameLists[idx] ?? []),
        summary: summaries.get(issue.id) ?? issue.title,
      };
    });

  // Rank by what it would cost to ignore the row: something you believed fixed,
  // then something you have never seen, then something climbing, then volume.
  //
  // isSpike() and not a bare ratio test. A one-event issue with no history has
  // baseline 0 and therefore ratio Infinity, so ranking on ratio alone floated
  // every trivial row above the 18-event issue the team is actually working on.
  // The event floor is what makes the ratio mean anything.
  // finalRetries sits above NEW and SPIKE because it is the only tier here that
  // is confirmed damage rather than a symptom: the job is not coming back and
  // whatever it was going to do did not happen. REGRESS stays on top — that one
  // means a fix we shipped did not hold.
  const weight = (r: OwnedRow) => (r.isRegressed ? 4 : r.finalRetries > 0 ? 3 : r.isNew ? 2 : isSpike(r) ? 1 : 0);
  rows.sort(
    (a, b) =>
      weight(b) - weight(a) ||
      Number(b.issue.count) - Number(a.issue.count) ||
      (b.ratio === Infinity ? 1 : b.ratio) - (a.ratio === Infinity ? 1 : a.ratio),
  );

  return { rows };
}

// ---------------------------------------------------------------------------
// RENDER
// ---------------------------------------------------------------------------

function levelColor(level: string): string {
  if (level === "fatal") return BRIGHT_RED;
  if (level === "error") return RED;
  if (level === "warning") return YELLOW;
  return GRAY;
}

function rule(label: string): string {
  const head = `── ${label} `;
  return `${DIM}${head}${"─".repeat(Math.max(0, WIDTH - head.length))}${RESET}`;
}

function renderReviews(r: Awaited<ReturnType<typeof fetchReviews>>, now: Date): string[] {
  // Deliberately NOT "since <window>". Every other section of the brief is a
  // delta; this one is a queue. A review you owe from Monday is still owed on
  // Friday, so age changes where the row sorts, never whether it appears.
  const out = [rule(`REVIEWS  🤝 ${SC_TEAM_NAME} · awaiting your review`), ""];

  if (r.note) {
    out.push(`  ${DIM}skipped — ${r.note}${RESET}`, "");
    return out;
  }
  if (!r.rows.length) {
    out.push(`  ${DIM}nothing waiting on you${RESET}`);
  }

  for (const row of r.rows.slice(0, MAX_ROWS)) {
    // 👀 = your review was actually requested; ✎ = you are already in the
    // conversation but never filed a review; 🤝 = untouched. The glyph is the
    // first thing on the line because it is the only field that changes how you
    // triage the row. All three markers occupy TWO columns — 👀/🤝 are naturally
    // wide and ✎ is padded to match — so the rest of the row stays on a grid.
    const marker = row.requestedOfMe ? "👀" : row.touchedByMe ? "✎ " : "🤝";
    const num = `#${row.number}`;
    const when = stamp(row.readyAt, now);
    const story = `sc-${row.storyId}`;

    // Lay the row out in PLAIN text first and measure it, then colorize. Doing
    // it the other way round makes every width here count ANSI and OSC-8 bytes
    // as if they were visible — the same trap the status strip documents.
    // The diff size (+212/−20) and file count used to sit between the author and
    // the timestamp. They are gone on purpose: this row exists to say WHAT needs
    // you and WHO is waiting, and a line that also tries to describe the shape of
    // the PR ends up describing neither. The 17 columns they cost are worth more
    // spent on the title, and the real size is one click away on the number.
    const prefix = `  ${marker} ${pad(num, 7)} ${pad(row.author, 14)} ${pad(when, 9)} `;
    const suffix = `${row.reReview ? " ↩re-review" : ""}${row.approvedByOthers ? " ✓others" : ""}  ${story}`;
    // Popmenu PR titles end in "[sc 174384]", and the row already carries that
    // ticket as its own linked column — so the tag in the title is the same fact
    // twice, eating width that the actual subject needs.
    const plainTitle = row.title.replace(/\s*\[sc[ -]?\d+\]\s*$/i, "");
    const title = trunc(plainTitle, Math.max(20, WIDTH - prefix.length - suffix.length));

    out.push(
      `  ${marker} ${BOLD}${link(pad(num, 7), row.url)}${RESET} ${pad(row.author, 14)} ` +
        `${DIM}${pad(when, 9)}${RESET} ${title}` +
        (row.reReview ? ` ${DIM}${YELLOW}↩re-review${RESET}` : "") +
        (row.approvedByOthers ? ` ${DIM}${GREEN}✓others${RESET}` : "") +
        `  ${DIM}${link(story, `https://app.shortcut.com/popmenu/story/${row.storyId}`)}${RESET}`,
    );
  }

  if (r.rows.length > MAX_ROWS) {
    out.push(`  ${DIM}… ${r.rows.length - MAX_ROWS} more awaiting you${RESET}`);
  }
  out.push("");
  return out;
}

function hm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// "45m", "1h", "1h30m" — never "0h45m", and never a bare decimal. This is read
// at a glance next to twelve other numbers.
function dur(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h${m}m` : `${h}h`;
}

function renderAgenda(a: { events: Meeting[]; note?: string }, now: Date): string[] {
  const out: string[] = [];

  if (a.note) {
    out.push(rule("AGENDA  📅"), "", `  ${DIM}skipped — ${a.note}${RESET}`, "");
    return out;
  }

  const allDay = a.events.filter((e) => e.all_day);
  const timed = a.events.filter((e) => !e.all_day);
  const booked = timed.reduce((n, e) => n + (new Date(e.end).getTime() - new Date(e.start).getTime()) / 60000, 0);

  const summary = timed.length
    ? `${timed.length} meeting${timed.length === 1 ? "" : "s"} · ${dur(Math.round(booked))} booked`
    : "clear";
  out.push(rule(`AGENDA  📅 ${now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${summary}`), "");

  // Banners first and dim: an OOO or a holiday frames the whole day but is not
  // an appointment, so it sits above the timeline rather than inside it.
  for (const e of allDay) {
    out.push(`  ${DIM}▫ all-day   ${trunc(e.title, WIDTH - 20)}${RESET}`);
  }

  if (!timed.length) {
    out.push(`  ${DIM}no meetings today${RESET}`, "");
    return out;
  }

  // ONE ROW PER MEETING, strictly. The gaps used to get rows of their own to make
  // this read as a timeline rather than a list, but a row per gap means a
  // four-meeting day costs seven rows, and the free-time arithmetic is something
  // you can do by eye from the start and end times that are already on screen.
  //
  // The one thing that does NOT survive being inferred is an overlap — two
  // meetings at once is a decision you have to make, not a gap you can read off
  // the clock — so it rides on the meeting's own row as a tail instead.
  let prevEnd: Date | null = null;
  let nextMarked = false;

  for (const e of timed) {
    const start = new Date(e.start);
    const end = new Date(e.end);
    const past = end <= now;
    const overlaps = prevEnd !== null && start.getTime() < prevEnd.getTime();

    // ● in progress · ▸ the next one you have to be at · ▪ everything else.
    // Only ONE row gets ▸ — the marker means "this is the one", and two of them
    // would mean neither is.
    let glyph = `${DIM}▪${RESET}`;
    let tail = "";
    if (e.in_progress) {
      glyph = `${GREEN}●${RESET}`;
      tail = ` ${GREEN}now${RESET}`;
    } else if (!past && !nextMarked) {
      glyph = `${CYAN}▸${RESET}`;
      tail = ` ${CYAN}in ${dur(Math.max(0, e.minutes_until))}${RESET}`;
      nextMarked = true;
    }

    const time = `${hm(e.start)}–${hm(e.end)}`;
    const mins = Math.round((end.getTime() - start.getTime()) / 60000);
    const join = e.join_url ? link("⧉", e.join_url) : " ";

    const prefix = `  ${" "}  ${time}  ${padStart(dur(mins), 5)}  ${" "} `;
    const title = trunc(e.title, Math.max(20, WIDTH - prefix.length - 14));
    const body = past ? `${DIM}${title}${RESET}` : title;

    const clash = overlaps ? ` ${ORANGE}⚠ overlaps${RESET}` : "";
    out.push(`  ${glyph}  ${past ? DIM : ""}${time}${RESET}  ${DIM}${padStart(dur(mins), 5)}${RESET}  ${join} ${body}${tail}${clash}`);
    prevEnd = end;
  }

  out.push("");
  return out;
}

// One issue, one line. `extra` is the per-section explanation of WHY this row
// is here (the spike ratio, "was fixed") — the tag alone says which bucket it
// landed in, not what made it interesting.
function sentryRow(
  i: SentryIssue,
  tag: string,
  tagColor: string,
  extraPlain = "",
  extraColored = "",
  suffix = "",
  deadCount = 0,
  text = "",
  showProject = false,
): string {
  // `text` is the cached one-line summary. Falls back to the raw Sentry title,
  // which is what you get before the first summarisation run or if `claude` is
  // unavailable.
  const body = text || i.title;
  const count = Number(i.count);
  const vol = padStart(count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count), 6);
  // A trailing "!" marks an UNHANDLED exception — something nobody rescued —
  // which is a sharper signal than the level, since half of Rails errors are
  // logged at `error` either way.
  const unh = i.isUnhandled ? "!" : " ";
  const users = i.userCount ? padStart(String(i.userCount), 4) + "u" : "     ";

  // Sentry's shortId is "<PROJECT-SLUG-UPPERCASED>-<SUFFIX>", e.g.
  // POPMENU-WEB-RAILS-109J. Only the suffix is worth a column: the prefix is the
  // project, which is either constant (so it is noise) or already shown in the
  // project column beside it (so it is duplicated). The suffix is what you type
  // into Sentry's search box and what you paste into a ticket.
  // Last column on the line because it is the answer to "is someone already on
  // this" — the thing you want after you have read what broke, not before.
  const scId = scStoryId(i);
  const scPlain = scId ? `  sc-${scId}` : "";

  const prefix_ = `${i.project.slug.toUpperCase()}-`;
  const sid = pad(i.shortId?.startsWith(prefix_) ? i.shortId.slice(prefix_.length) : (i.shortId ?? "?"), 6);
  const proj = showProject ? pad(trunc(i.project.slug.replace(/^popmenu-/, ""), 14), 14) + " " : "";

  // Fixed-width slot so the columns still line up on the rows that have no dead
  // jobs, which is most of them. "⛔3" renders as three columns (the glyph is
  // double-width), so the slot is 4 and blank rows pay 4 spaces.
  const dead = deadCount > 0 ? pad(`⛔${deadCount}`, 3) : "   ";
  const deadPlain = deadCount > 0 ? pad(`XX${deadCount}`, 4) : "    ";

  const prefix = `  ${pad(tag, 7)} ${vol}×${unh} ${deadPlain}${users} ${sid} ${proj}`;
  const avail = Math.max(24, WIDTH - prefix.length - extraPlain.length - scPlain.length - 1);

  // When a suffix is present the title is, by construction, a DUPLICATE — that
  // is the only reason disambiguators() emits one — so the informative half of
  // the line is the suffix, not the title. Split the budget accordingly instead
  // of letting an unbounded culprit both squeeze the title to "OpenTable::Sy…"
  // and still run off the right edge.
  let title: string;
  let suf = "";
  if (suffix) {
    const sufBudget = Math.max(18, Math.floor(avail * 0.55));
    suf = ` · ${trunc(suffix, sufBudget)}`;
    title = trunc(body, Math.max(14, avail - suf.length));
  } else {
    title = trunc(body, avail);
  }

  return (
    `  ${tagColor}${pad(tag, 7)}${RESET} ${levelColor(i.level)}${vol}×${RESET}${ORANGE}${unh}${RESET} ` +
    `${deadCount > 0 ? `${BRIGHT_RED}${dead}${RESET} ` : "    "}` +
    `${DIM}${users}${RESET} ${CYAN}${sid}${RESET} ${proj ? `${DIM}${proj}${RESET}` : ""}${link(title, i.permalink)}${suf ? `${DIM}${suf}${RESET}` : ""}` +
    (extraColored ? ` ${extraColored}` : "") +
    (scId ? `  ${GREEN}${link(`sc-${scId}`, `https://app.shortcut.com/popmenu/story/${scId}`)}${RESET}` : "")
  );
}

// Direction, not magnitude. On a bug you are working, "18 events" says nothing;
// "up 1.5x on its own two-week baseline" says the fix is not landing yet.
function trend(count: number, baseline: number): { plain: string; colored: string } {
  // baseline 0 means the issue was silent for all 13 prior days. On a 1-event
  // row that is "first sighting", not "spiking" — saying "no baseline" invited
  // reading it as alarming.
  if (baseline <= 0) return { plain: "first in 13d", colored: `${DIM}first in 13d${RESET}` };
  const r = count / baseline;
  if (r >= TREND_UP)
    return {
      plain: `↑${r.toFixed(1)}× vs ${baseline}/day`,
      colored: `${ORANGE}↑${r.toFixed(1)}×${RESET} ${DIM}vs ${baseline}/day${RESET}`,
    };
  if (r <= TREND_DOWN)
    return {
      plain: `↓${r.toFixed(1)}× vs ${baseline}/day`,
      colored: `${GREEN}↓${r.toFixed(1)}×${RESET} ${DIM}vs ${baseline}/day${RESET}`,
    };
  return { plain: `steady ~${baseline}/day`, colored: `${DIM}steady ~${baseline}/day${RESET}` };
}

// Sentry titles are not unique. The two OpenTable::Sync::UnhandledError issues
// the team is working on have BYTE-IDENTICAL titles; the only thing telling them
// apart is the culprit — Sidekiq/OpenTableSync::GuestsSync versus
// ::ReservationsSync. Two rows a reader cannot distinguish are worse than one,
// so where a title repeats, the culprit is appended. Only where it repeats:
// paying that width on every row would cost title text to solve a problem most
// rows do not have.
function disambiguators(rows: { issue: SentryIssue; summary: string }[]): Map<string, string> {
  // Keyed on the text the reader actually SEES. Two issues with different titles
  // can share a summary, and then the summary is the thing that needs the
  // culprit appended — checking titles would miss exactly that case.
  const seen = new Map<string, number>();
  for (const { summary } of rows) seen.set(summary, (seen.get(summary) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const { issue: i, summary } of rows) {
    if ((seen.get(summary) ?? 0) < 2) continue;
    const culprit = (i.culprit ?? "").split("/").pop() ?? "";
    if (culprit) out.set(i.id, culprit);
  }
  return out;
}

// ---- grouping ----
//
// The section used to be one flat ranked list, and the ranking was doing a job it
// could not do: every row got a full line whether or not there was anything left
// to decide about it. Three quarters of a normal morning is rows you have already
// disposed of — a ticket exists, it is another team's code, or a Sidekiq job blew
// up and then retried successfully. Those are not findings, they are receipts.
//
// So each row lands in exactly ONE bucket and only NOVEL earns a full line. The
// rest collapse to a single counted line apiece, which is enough to notice a
// number that looks wrong and go digging.
type Bucket = "novel" | "ticketed" | "reassign" | "retriedClean" | "steady";

// Sentry's culprit for a background job is "Sidekiq/Some::JobClass". This is the
// only way to tell a job from a web request here, and it matters because the two
// have completely different failure economics — see retriedClean below.
function isSidekiq(i: SentryIssue): boolean {
  return /^Sidekiq\//.test(i.culprit ?? "");
}

function scStoryId(i: SentryIssue): string | undefined {
  return i.annotations
    ?.map((a) => a.url?.match(/app\.shortcut\.com\/[^/]+\/story\/(\d+)/)?.[1])
    .find(Boolean);
}

// The leading word of the summary, which is what makes "Follower search reindex
// timing out" and "Follower birthday sync times out" one family. Culprit would be
// the more principled key and it does not work: those two are
// User::UpdateUserSearchOnFollower and User::UpdateFollowerBirthday, which share
// no prefix at all. The summaries are LLM-written to a house style that puts the
// subsystem first, so their first word is the most reliable family signal here.
function familyOf(r: OwnedRow): string {
  const first = (r.summary || r.issue.title).trim().split(/[\s/]+/)[0] ?? "";
  return first.replace(/[^A-Za-z-]/g, "");
}

function bucketOf(r: OwnedRow): Bucket {
  // REGRESS overrides everything, including a ticket. It means a fix that shipped
  // did not hold, which is new information no matter who owns the ticket.
  if (r.isRegressed) return "novel";
  if (scStoryId(r.issue)) return "ticketed";
  if (r.suggestedTeam) return "reassign";
  // A Sidekiq job with no sidekiq_final_retry event in the window threw and then
  // succeeded on a retry. Noisy, not damaging: nothing was lost. That is the
  // single biggest source of rows that look urgent and are not.
  if (isSidekiq(r.issue) && r.finalRetries === 0) return "retriedClean";
  // Not new, not climbing, nothing lost — it was here yesterday and it is here
  // today at the same rate. Worth a count, not a line.
  if (!r.isNew && !isSpike(r) && r.finalRetries === 0) return "steady";
  return "novel";
}

// "Follower ×4, campaign ×2" — the families inside a collapsed bucket, biggest
// first, singletons dropped. Without this a collapsed line says only how many
// rows it swallowed, which is exactly the number you cannot act on.
function familyBreakdown(rows: OwnedRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const f = familyOf(r);
    if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const multi = [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  return multi.map(([f, n]) => `${f} ×${n}`).join(", ");
}

function eventTotal(rows: OwnedRow[]): number {
  return rows.reduce((n, r) => n + Number(r.issue.count), 0);
}

function renderSentry(s: Awaited<ReturnType<typeof fetchSentry>>, hours: number): string[] {
  const days = Math.round(hours / 24);
  // Header is rule + blank, same as every other section. The ⛔ key used to live
  // here and it read wrong twice over: it made this one header two lines tall
  // when the others are one, and its glyph sat at the left margin rather than
  // under the column the glyph actually appears in, so it looked like a stray
  // error bullet instead of a key. It is a footnote now — see the bottom.
  // "assigned to us" used to sit in this header. Every row in the section is
  // assigned to the team by construction — that IS the query — so it described
  // the code rather than the data and earned none of its width.
  const out = [rule(`SENTRY  🔥 ${SC_TEAM_NAME} · ${days}d window · 24h rates`), ""];

  if (s.note) {
    out.push(`  ${DIM}skipped — ${s.note}${RESET}`, "");
    return out;
  }
  if (!s.rows.length) {
    out.push(`  ${DIM}nothing the team owns fired in the last 24h${RESET}`, "");
    return out;
  }

  const disamb = disambiguators(s.rows.map((r) => ({ issue: r.issue, summary: r.summary })));

  // The project column is only worth its 14 columns when the rows actually span
  // projects. In practice the team owns one — every row read "web-rails", which
  // is a column that never varies and so tells you nothing. The short id below
  // carries the project as its prefix anyway, so nothing is lost by dropping it.
  const showProject = new Set(s.rows.map((r) => r.issue.project.slug)).size > 1;

  const grouped = new Map<Bucket, OwnedRow[]>();
  for (const r of s.rows) {
    const b = bucketOf(r);
    grouped.set(b, [...(grouped.get(b) ?? []), r]);
  }
  const novel = grouped.get("novel") ?? [];

  for (const r of novel.slice(0, MAX_ROWS)) {
    // The tag is the single most alarming true thing about the row, not a
    // category it lives in — the rows are one list now.
    const [tag, color] = r.isRegressed
      ? ["REGRESS", MAGENTA]
      : r.isNew
        ? ["NEW", YELLOW]
        : isSpike(r)
          ? ["SPIKE", ORANGE]
          : ["·", CYAN];
    const t = trend(Number(r.issue.count), r.baseline);
    // The suggestion rides at the END of the line, after the trend, because it is
    // advice rather than a fact about the error — it should be the last thing you
    // read, and the "?" is doing real work: this is a hint to check, not a verdict.
    // ↩ rather than →: a u-turn reads as "send this back", which is what it is.
    // Yellow because it wants a decision, not because anything is broken.
    const hint = r.suggestedTeam
      ? { plain: ` ↩ ${r.suggestedTeam}`, colored: ` ${YELLOW}↩ ${r.suggestedTeam}${RESET}` }
      : null;
    out.push(
      sentryRow(
        r.issue,
        tag,
        color,
        t.plain + (hint?.plain ?? ""),
        t.colored + (hint?.colored ?? ""),
        disamb.get(r.issue.id) ?? "",
        r.finalRetries,
        r.summary,
        showProject,
      ),
    );
  }
  if (novel.length > MAX_ROWS) {
    out.push(`  ${DIM}… ${novel.length - MAX_ROWS} more novel${RESET}`);
  }

  // The collapsed buckets. One line each, in descending order of "how safe is it
  // to not read this" — the safest last.
  // The disposed-of buckets, TWO PER LINE. They are short by construction — a
  // glyph, a label and two numbers — so one per line left half the section as
  // trailing whitespace and made four quiet facts look like four findings.
  //
  // Uniformly muted, with no per-bucket colour. That is the design carrying the
  // message that used to be a sentence: colour in this section means "look at
  // this", so the total absence of colour IS "nothing here wants you". Giving
  // ticketed its own green and reassign its own yellow made the safe half of the
  // section compete with the half that matters.
  // Short labels, and each one says the DISPOSITION rather than the mechanism —
  // "self-healed" is why you can skip the row; "sidekiq_final_retry was absent" is
  // only how we know. The mechanism lives in bucketOf(), where it belongs.
  const buckets: [Bucket, string, string][] = [
    ["ticketed", "🎫", "on the board"],
    ["reassign", "↩ ", "another team"],
    ["retriedClean", "💤", "self-healed"],
    ["steady", "· ", "flat"],
  ];
  // Half the brief, less the left margin and the gutter between the two columns.
  const COL = Math.floor((WIDTH - 6) / 2);
  const cells: string[] = [];
  for (const [b, glyph, label] of buckets) {
    const rows = grouped.get(b) ?? [];
    if (!rows.length) continue;
    // j for jobs, nothing for issues — the 💤 glyph already says "background job",
    // so spelling it out twice on the same line is wasted width.
    const noun = b === "retriedClean" ? "j" : "";
    let detail = "";
    if (b === "ticketed") {
      // The only bucket where the identifiers ARE the detail: they are what you
      // click to see whether the work has actually moved since yesterday.
      const ids = [...new Set(rows.map((r) => scStoryId(r.issue)).filter(Boolean))] as string[];
      detail = ids.map((id) => `sc-${id}`).join(" ");
    } else if (b === "reassign") {
      detail = [...new Set(rows.map((r) => r.suggestedTeam).filter(Boolean))].join(", ");
    } else {
      const bits = [familyBreakdown(rows)].filter(Boolean);
      // A job can retry clean and still be climbing. Nothing was lost so it does
      // not earn a row, but "6 jobs, all fine" would be the wrong impression to
      // leave when one of them tripled — so the climber count rides along.
      const climbing = rows.filter((r) => isSpike(r)).length;
      if (climbing) bits.push(`${climbing} climbing`);
      detail = bits.join(" · ");
    }
    // "3 · 42ev" rather than "3 issues   42 events": at two columns the words cost
    // more than they explain, and the numbers are self-evident in context.
    const count = `${rows.length}${noun} · ${eventTotal(rows)}ev`;
    // Built as PLAIN text and padded here; colour is applied once to the whole
    // finished line below, so these widths measure characters and not ANSI bytes.
    //
    // detail is the only free-form part, so it is the only thing trunc() touches —
    // trunc collapses runs of whitespace, which would eat every pad() around it.
    const detailRoom = COL - 30;
    if (detailRoom > 8) detail = trunc(detail, detailRoom);
    cells.push(`${glyph} ${pad(label, 13)} ${padStart(count, 11)}  ${detail}`);
  }

  if (cells.length) {
    if (novel.length) out.push("");
    for (let i = 0; i < cells.length; i += 2) {
      const left = cells[i];
      const right = cells[i + 1] ?? "";
      // pad(), never trunc(): these cells are already spaced into columns.
      out.push(`  ${DIM}${right ? `${pad(left, COL)}  ${right}` : left}${RESET}`);
    }
  }
  const collapsed = cells;
  // Only when it is actually on screen. A key for a glyph no row is wearing is
  // pure noise, and most mornings no row wears this one.
  const shown = novel.slice(0, MAX_ROWS);
  if (shown.some((r) => r.finalRetries > 0)) {
    out.push(`  ${DIM}⛔n — n of those events exhausted their Sidekiq retries; that work is gone${RESET}`);
  }
  if ((grouped.get("reassign") ?? []).length) {
    out.push(`  ${DIM}↩ advice only — run /sentry-assignment before moving anything${RESET}`);
  }
  out.push("");
  return out;
}

async function render(): Promise<string> {
  const now = new Date();
  const start = windowStart(now);
  const hours = Math.ceil((now.getTime() - start.getTime()) / 3_600_000);

  // Both halves run concurrently and neither can take the other down: a
  // Shortcut outage must not cost you the Sentry section.
  const [reviews, sentryData] = await Promise.all([
    fetchReviews().catch((e) => ({ rows: [], note: (e as Error).message })),
    fetchSentry(now).catch((e) => ({ rows: [], note: (e as Error).message })),
  ]);
  // Synchronous and local — a subprocess against EventKit, no network — so it
  // is not worth folding into the Promise.all above.
  const agenda = fetchAgenda();

  const when = `${now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}`;
  const since = `${start.toLocaleDateString("en-US", { weekday: "short" })} ${WINDOW_HOUR}:00`;

  const lines: string[] = [
    "",
    `  ${BOLD}MORNING BRIEF${RESET}  ${DIM}${when} · since ${since}${RESET}`,
    "",
    ...renderAgenda(agenda, now),
    ...renderReviews(reviews, now),
    ...renderSentry(sentryData, SENTRY_WINDOW_HOURS),
    `${DIM}  ${MY_LOGIN} · generated ${now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}${RESET}`,
    "",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

function cachePath(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return path.join(CACHE_DIR, `brief-${y}-${m}-${day}.txt`);
}

async function main() {
  const mode = process.argv[2] ?? "";

  if (mode === "--json") {
    const now = new Date();
    const [reviews, sentryData] = await Promise.all([
      fetchReviews().catch((e) => ({ error: (e as Error).message })),
      fetchSentry(now).catch((e) => ({ error: (e as Error).message })),
    ]);
    console.log(
      JSON.stringify({ windowStart: windowStart(now), agenda: fetchAgenda(), reviews, sentry: sentryData }, null, 2),
    );
    return;
  }

  // Everything from scratch: no rendered brief, no cached summaries. This is the
  // slow, honest path — it is what the 06:00 run would produce on a machine that
  // had never run it before.
  if (mode === "--fresh") {
    IGNORE_SUMMARY_CACHE = true;
    WIDTH = BRIEF_WIDTH;
    const text = await render();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(), text);
    process.stdout.write(text);
    return;
  }

  if (mode === "--cached") {
    const p = cachePath();
    if (fs.existsSync(p)) {
      process.stdout.write(fs.readFileSync(p, "utf8"));
      return;
    }
    // No file yet — you woke the machine after 6am, or launchd never fired.
    // Generate on the spot rather than showing an empty popup. Pinned to
    // BRIEF_WIDTH like --write, because this branch caches what it renders.
    WIDTH = BRIEF_WIDTH;
    const text = await render();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(p, text);
    process.stdout.write(text);
    return;
  }

  if (mode === "--write") WIDTH = BRIEF_WIDTH;
  const text = await render();

  if (mode === "--write") {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const p = cachePath();
    fs.writeFileSync(p, text);
    console.error(`wrote ${p}`);
    return;
  }

  process.stdout.write(text);
}

main().catch((err) => {
  console.error(`morning-brief: ${(err as Error).message}`);
  process.exit(1);
});
