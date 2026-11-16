#!/usr/bin/env -S npx tsx
/**
 * Compact (2-3 line) tmux pane widget tracking three categories of PR activity:
 *
 * ON YOUR OWN PRs — badge shows when someone else has the last word:
 *   💬  a human replied
 *   🐛  Cursor Bugbot (or any bot with "cursor"/"bugbot" in its username)
 *
 * ON OTHER PEOPLE'S PRs (threads where you've left a comment):
 *   🗣️  you commented, no reply yet — you're the one waiting
 *   👥  someone replied to your comment — active back-and-forth
 *   🐛  a bot replied to your comment
 *
 * @-MENTIONS — someone named you on any open PR (`mentions:` search):
 *   📣  you were @-mentioned and haven't answered
 *   🐛  a bot @-mentioned you
 *   Covers the surfaces the other categories structurally can't: the PR's
 *   CONVERSATION TIMELINE (every other badge here comes from reviewThreads, so a
 *   plain "@you take a look" on the main thread used to produce nothing at all),
 *   plus review threads you have never commented in (the participating category
 *   skips those by design). Review-thread mentions in threads you're already in are
 *   deliberately left to 👥/🗣️ so the same comment isn't badged twice.
 *   ONE badge per PR, pointed at the newest mention — being named repeatedly is
 *   still one thing to go read.
 *   Clears when you comment anywhere on the PR after the mention, or leave ANY
 *   reaction on the mentioning comment.
 *
 * YOUR TEAM'S REVIEW QUEUE — from SHORTCUT, not GitHub:
 *   🤝  a PR attached to a ticket in your team's "Ready for Review" OR "In
 *       Development" column — see SC_REVIEW_STATE_NAMES for why both
 *       that still needs review (not yours, not draft/closed/merged, and not
 *       already approved).
 *   Shortcut-driven because the GitHub framings are unusable at this repo's scale:
 *   153 open PRs, 144 not yours, 65 even after non-draft/untouched/this-week
 *   filtering. "Tickets in MY TEAM's Ready for Review column" is 3, and 1 after
 *   filtering — the same question with three orders of magnitude less noise.
 *   Needs SHORTCUT_RO_TOKEN; without it the category is skipped and nothing else
 *   changes. Team + column are configured BY NAME (SC_TEAM_NAME /
 *   SC_REVIEW_STATE_NAMES) and resolved to ids at runtime.
 *   Clears itself when the story leaves Ready for Review.
 *
 * REVIEW EFFORT — every row in the "team" section carries L / M / H (green /
 *   yellow / red), a low/medium/high review-effort rating, and the section is
 *   sorted low → high so quick reviews come first. Unrated rows show a dim · and
 *   sort last. Ratings come from a quick glance by headless Claude (Haiku) at the
 *   title, description, size, and file list, and are cached for 30 days per PR
 *   in ~/.local/state/termdash/pr-effort.json. See pr-effort.ts;
 *   `npx tsx pr-effort.ts` lists the cache.
 *
 * PENDING REVIEW REQUESTS — PRs where you're a requested reviewer:
 *   👀  no action from you yet
 *   👔  same, but the request came only via LEAD_REVIEW_TEAM (a team you're in,
 *       auto-tagged on lots of PRs) rather than to you by name — see
 *       LEAD_REVIEW_TEAM for why it's split out. Omitted entirely once the PR
 *       has LEAD_REVIEW_APPROVALS (2) approvals.
 *   Clears once you've either submitted a formal review (approve, request
 *   changes, or a review-comment) OR left a plain comment — either counts
 *   as "handled" even though GitHub itself only auto-clears the request on
 *   a formal review, not a plain comment.
 *
 * QA APP STATUS — on your own PRs, driven by QA engineers' commands left as
 * top-level PR comments (some variation of "qa app deploy" / "qa app
 * destroy"):
 *   👷  QA app deployed — the ticket is up in a QA environment, under test
 *   ✅  QA app destroyed — the ticket passed QA (they tear it down on pass)
 *   State is purely the MOST RECENT matching comment, so a later re-deploy
 *   flips ✅ back to 👷. No matching comment → no QA badge.
 *
 * All badges clear automatically once you have the last word (own PRs) or
 * once nobody needs to check back (participating threads, resolved).
 * A thread going "outdated" (the yellow tag GitHub shows when the diff it's
 * anchored to has since changed) gets the same treatment as resolved.
 * Either way, hidden UNLESS the last comment @-mentions you.
 * A 👍 reaction from you on someone's reply also clears it immediately —
 * treated as "acknowledged, no reply needed" independent of GitHub's own
 * resolved state. The reverse works too, but scoped to the PR AUTHOR
 * specifically: if you have the last word (🗣️) and the PR's author 👍's
 * your comment, that's treated as a soft resolution — they've signaled
 * agreement without needing to write a reply. A 👍 from some other
 * commenter doesn't carry the same weight and won't clear it.
 *
 * Command-click any badge to jump straight to that comment on GitHub.
 *
 * COST NOTE: confirmed by manual test that GitHub reactions do NOT bump a
 * PR's updated_at. Since only the reaction-dependent rules above are
 * affected (the participating category, plus 📣's clear-on-reaction), only PRs
 * currently holding a live badge of those kinds get periodically force-rechecked —
 * not your whole PR list. Own-PR (💬) badges never depend on reactions and
 * are never force-refreshed. The mention category also uses its own GraphQL query
 * (MENTIONS_QUERY) rather than widening the shared one, so pulling conversation-
 * timeline comments doesn't raise the per-PR cost of every other category.
 *
 * SETUP:
 *   export GITHUB_TOKEN="$(gh auth token)"
 *   npx tsx pr-comment-bubbles.ts
 *
 * TESTING:
 *   npx tsx pr-comment-bubbles.ts --mock
 *     Renders a fixed set of fake badges (one of each kind) so you can
 *     check layout/wrapping without hitting the API.
 *
 *   npx tsx pr-comment-bubbles.ts --limits
 *     Quick, near-zero-cost check of your current GraphQL budget alone —
 *     no PR data pulled. Useful without disturbing the live pane's layout.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { summarizeComments, type RawComment } from "./herdr-space-tokens.ts";
import { effortOf, rateEfforts, EFFORT_RANK, type Effort } from "./pr-effort.ts";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
// With per-PR caching skipping GraphQL calls for anything unchanged since
// the last poll, steady-state cost should be well under naive worst case.
// Starting at 60s per your request — watch the always-visible GraphQL
// budget line and color thresholds to see how close to the edge this runs.
const POLL_SECONDS = 60;
const API = "https://api.github.com";
const GRAPHQL_URL = "https://api.github.com/graphql";

// ---- Shortcut (drives the 🤝 team-review category) ----
// Read-only token, the same one already exported in ~/.zsh-sources/exports.zsh.
// Without it the 🤝 category is simply skipped — every other badge is unaffected.
const SHORTCUT_TOKEN = process.env.SHORTCUT_RO_TOKEN;
const SHORTCUT_API = "https://api.app.shortcut.com/api/v3";

// Which team's column to watch, BY NAME. Resolved to ids at runtime rather than
// hardcoded, so renaming the team or reordering the workflow doesn't silently turn
// this category off — a rename produces no badges, but so would a stale id, and a
// name is at least something you can eyeball against the Shortcut UI.
const SC_TEAM_NAME = "Marketeers";

// Plural, and BOTH entries earn their place.
//
// "Ready for Review" is the column this category is named after. "In Development"
// is here because the column is a human ritual and the PR is not: people open a
// PR and forget to drag the ticket, and that PR is then invisible to a query
// keyed on the column. Measured on the live board, In Development held exactly
// one open non-draft PR still awaiting review and Ready for Review held four —
// so this widening costs one row and closes the hole.
//
// The post-review states (Ready for QA / In QA / Ready for Merge) are left OUT
// on purpose: a ticket only reaches them after someone reviewed it, and the
// GitHub approval gate in filterUnapprovedOnGitHub would drop them anyway.
const SC_REVIEW_STATE_NAMES = ["Ready for Review", "In Development"];

// Your own PRs are excluded — you don't need to review your own work. Matched on the
// branch PREFIX because that's the only author-ish signal Shortcut hands back on an
// attached PR (there's no author field), and it can't be derived from your GitHub
// login: the login is `colintsteele` but the branches are `steele/...`.
const MY_BRANCH_PREFIX = "steele/";

interface GraphQLComment {
  author: { login: string } | null;
  createdAt: string;
  url: string;
  body: string;
  reactions: { nodes: { user: { login: string } | null }[] };
}

interface ReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  comments: { nodes: GraphQLComment[] };
}

// ---- comment summaries: this pane is the PRODUCER ----
//
// The summariser and its cache live in herdr-space-tokens.ts, keyed by comment
// id in ~/.local/state/herdr/comment-summaries.json. A comment's text never
// changes, so each id is summarised exactly ONCE, ever; this pane is where that
// cache gets filled, and morning-brief.ts and the Herdr sidebar are readers.
//
// Why here rather than in the brief: every comment this pane badges has already
// been fetched WITH ITS BODY for the badge logic, so summarising what is already
// in hand costs zero additional API calls. No other consumer can say that — the
// brief would have to re-fetch, and it runs once a day at 06:00 against a cold
// cache. Warming from the pane that polls every 60s means the brief's rows are
// almost always already paid for by the time it runs.
//
// REST ids on purpose: the `#discussion_r<id>` / `#issuecomment-<id>` fragment of
// a GraphQL comment url is the same number fetchComments() reports, so both
// producers share ONE keyspace instead of summarising a comment twice under two.
const COMMENT_ID_RE = /#(?:discussion_r|issuecomment-)(\d+)/;
const seenComments = new Map<string, RawComment>();

function noteComments(nodes: GraphQLComment[]): void {
  for (const c of nodes) {
    const m = c.url?.match(COMMENT_ID_RE);
    if (!m) continue;
    seenComments.set(m[1], {
      id: m[1],
      author: c.author?.login ?? "?",
      body: c.body ?? "",
      url: c.url,
    });
  }
}

// Deliberately never awaited by the render path. Summarising shells out to
// headless Claude with a 120s timeout and this pane repaints every 60s, so
// blocking the paint on it would turn a nicety into a stall. The guard is what
// keeps two overlapping polls from running the summariser twice over one batch.
let warming = false;
async function warmCommentSummaries(): Promise<void> {
  if (warming) return;
  const raw = [...seenComments.values()].filter((c) => c.body.trim());
  seenComments.clear();
  if (raw.length === 0) return;
  warming = true;
  try {
    await summarizeComments(raw);
  } catch {
    /* a failed warm costs a re-ask on the next poll, not correctness */
  } finally {
    warming = false;
  }
}

interface RateLimitInfo {
  cost: number;
  remaining: number;
  limit: number;
  resetAt: string;
}

interface PRThreadsData {
  rateLimit: RateLimitInfo | null;
  repository: {
    pullRequest: {
      reviewThreads: { nodes: ReviewThread[] };
    } | null;
  } | null;
}

interface Badge {
  icon: string;
  url: string;
  createdAt: string;
  repo: string; // "owner/repo"
  prNumber: number;
  author?: string; // PR author's login — drives the 👔 fold and which section the row lands in
}

interface SearchItem {
  number: number;
  repository_url: string;
  html_url: string;
  updated_at: string;
  user: { login: string } | null; // the PR author
}

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    rateLimit {
      cost
      remaining
      limit
      resetAt
    }
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 20) {
          nodes {
            isResolved
            isOutdated
            comments(first: 15) {
              nodes {
                author { login }
                createdAt
                url
                body
                reactions(content: THUMBS_UP, first: 5) {
                  nodes {
                    user { login }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// @-mentions need a DIFFERENT shape than the review-thread categories: the mention
// usually lands in the PR's conversation timeline (`comments`), which the badge
// pipeline never read — reviewThreads only covers code-review comments, so a
// "@you can you look at this" on the main thread produced no badge at all.
//
// Kept as its own query rather than bolting `comments` onto REVIEW_THREADS_QUERY
// so the own/participating categories don't start paying for 50 extra comment nodes
// on every PR they refresh. Only the handful of PRs from the `mentions:` search
// pay for this.
//
// reactionGroups (not `reactions`) because the clear-on-reaction rule is "ANY
// reaction from me", and reactionGroups gives that in one field per content type
// without paginating other people's reactions. NB `viewerHasReacted` does NOT exist
// on IssueComment / PullRequestReviewComment — reactionGroups is the way in.
const MENTIONS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    rateLimit {
      cost
      remaining
      limit
      resetAt
    }
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        comments(last: 50) {
          nodes {
            author { login }
            createdAt
            url
            body
            reactionGroups { viewerHasReacted }
          }
        }
        reviewThreads(first: 20) {
          nodes {
            comments(first: 15) {
              nodes {
                author { login }
                createdAt
                url
                body
                reactionGroups { viewerHasReacted }
              }
            }
          }
        }
      }
    }
  }
`;

interface MentionComment {
  author: { login: string } | null;
  createdAt: string;
  url: string;
  body: string;
  reactionGroups: { viewerHasReacted: boolean }[];
}

interface PRMentionsData {
  rateLimit: RateLimitInfo | null;
  repository: {
    pullRequest: {
      comments: { nodes: MentionComment[] };
      reviewThreads: { nodes: { comments: { nodes: MentionComment[] } }[] };
    } | null;
  } | null;
}

function isBot(login: string): boolean {
  return /cursor|bugbot/i.test(login);
}

// ---- rate limit display colors ----
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const YELLOW = "\x1b[33m";
const ORANGE = "\x1b[38;5;208m";
const RED = "\x1b[31m";
// The one clickable affordance in this pane, so it gets the one colour nothing
// else here uses. Same blue as the ⎇ PR link in the peers pane on purpose: across
// the dashboard, this blue means "this is a link and it goes to GitHub".
// Dim was wrong for it — dim is what the pane says when it has nothing to offer
// ("no pending replies"), which is the opposite of an action.
const LINK_BLUE = "\x1b[38;5;75m";

function rateLimitColor(remaining: number, limit: number): string {
  const pct = (remaining / limit) * 100;
  if (pct <= 10) return RED;
  if (pct <= 25) return ORANGE;
  if (pct <= 50) return YELLOW;
  return DIM; // plenty left — stay unobtrusive
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w`;
}

function link(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

// Route links through the `termdash:` scheme so a cmd-click reuses the Chrome tab
// you already have open for that PR instead of stacking duplicates — the handler
// keys every badge on this PR to `…/pull/<n>`, so all four 🗣️ badges on one PR
// share a tab. It still scrolls to each badge's own #discussion_r… comment: a
// fragment-only URL change is a same-document navigation, so you get the anchor
// without a reload and without losing the tab's scroll or in-progress review.
//
// Payload is percent-encoded because the inner URL has its own ? and #: nested
// raw, NSURL reads them as the OUTER url's query/fragment and mangles the link.
//
// OFF unless TERMDASH_REUSE_TABS=1 — a `termdash:` link is inert on a machine
// without TermDashOpen.app installed. See tab-reuse.md.
const REUSE_TABS = process.env.TERMDASH_REUSE_TABS === "1";

function webLink(text: string, url: string): string {
  return link(text, REUSE_TABS ? `termdash:${encodeURIComponent(url)}` : url);
}

async function gh<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function ghGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const resetHeader = res.headers.get("x-ratelimit-reset");
  const resetSuffix = resetHeader
    ? ` (resets at ${new Date(parseInt(resetHeader, 10) * 1000).toLocaleTimeString()})`
    : "";

  if (!res.ok) throw new Error(`graphql -> ${res.status}${resetSuffix}`);
  const json = await res.json();
  if (json.errors) {
    throw new Error(json.errors.map((e: { message: string }) => e.message).join("; ") + resetSuffix);
  }
  return json.data as T;
}

let cachedUsername: string | null = null;
async function getUsername(): Promise<string> {
  if (cachedUsername) return cachedUsername;
  const user = await gh<{ login: string }>("/user");
  cachedUsername = user.login;
  return cachedUsername;
}

async function searchPRs(query: string): Promise<SearchItem[]> {
  const q = encodeURIComponent(query);
  const result = await gh<{ items: SearchItem[] }>(`/search/issues?q=${q}&per_page=50`);
  return result.items;
}

let lastKnownRateLimit: RateLimitInfo | null = null;

// Cache badges per PR keyed by its last-seen updated_at. If a PR's
// updated_at hasn't moved since last poll, skip the GraphQL call entirely
// and reuse what we already have — this is what makes fast polling (30-60s)
// affordable instead of burning the whole hourly budget on idle PRs.
const prBadgeCache = new Map<string, { updatedAt: string; badges: Badge[] }>();

// Confirmed by manual test: reactions do NOT bump a PR's updated_at, so the
// cache can't detect "a reaction alone resolved this." That only matters for
// the two reaction-dependent rules — both live in the PARTICIPATING category
// (🗣️ cleared by the PR author's 👍, 👥 cleared by your own 👍). Own-PR (💬)
// badges never depend on reactions, so they need no safety net at all.
//
// Rather than force-refreshing every PR periodically (expensive, and mostly
// wasted on PRs where a stale reaction couldn't matter), we only bypass the
// cache for PRs that currently hold a live participating-category badge —
// a much smaller set most of the time.
const activeParticipatingKeys = new Set<string>();

// Same idea for the mention category: "any reaction from me clears it" is likewise
// invisible to updated_at, so PRs currently holding a 📣 need the same periodic
// recheck. Kept as a separate set so a live 📣 doesn't drag participating PRs into a
// refresh, or vice versa.
const activeMentionKeys = new Set<string>();

const FORCE_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
let lastForceRefreshAt = 0;

// Called ONCE per poll from fetchBadges, and the answer passed down to every
// category that needs it. It has to work that way: the call flips lastForceRefreshAt
// as a side effect, so two categories calling it inside the same Promise.all would
// race — whichever ran first would consume the refresh and the other would silently
// never force one.
function shouldForceRefresh(): boolean {
  const now = Date.now();
  if (now - lastForceRefreshAt > FORCE_REFRESH_INTERVAL_MS) {
    lastForceRefreshAt = now;
    return true;
  }
  return false;
}

async function fetchReviewThreads(owner: string, repo: string, number: number): Promise<ReviewThread[]> {
  const result = await ghGraphQL<PRThreadsData>(REVIEW_THREADS_QUERY, { owner, repo, number });
  if (result.rateLimit) lastKnownRateLimit = result.rateLimit;
  return result.repository?.pullRequest?.reviewThreads.nodes ?? [];
}

function repoOwnerFromUrl(repoUrl: string): [string, string] {
  const repoPath = repoUrl.replace(`${API}/repos/`, "");
  const [owner, repo] = repoPath.split("/");
  return [owner, repo];
}

// ---- category 1: your own PRs — badge when someone else has the last word ----

async function fetchOwnPRBadges(
  meLower: string,
  mentionTag: string
): Promise<{ badges: Badge[]; errors: string[] }> {
  const items = await searchPRs(`is:pr is:open author:${meLower}`);
  const badges: Badge[] = [];
  const errors: string[] = [];

  for (const item of items) {
    const [owner, repo] = repoOwnerFromUrl(item.repository_url);
    const cacheKey = `own:${owner}/${repo}#${item.number}`;
    const cached = prBadgeCache.get(cacheKey);

    if (cached && cached.updatedAt === item.updated_at) {
      badges.push(...cached.badges);
      continue; // unchanged since last poll — skip the GraphQL call entirely
    }

    let threads: ReviewThread[];
    try {
      threads = await fetchReviewThreads(owner, repo, item.number);
    } catch (err) {
      errors.push(`${owner}/${repo}#${item.number}: ${(err as Error).message}`);
      continue;
    }

    const prBadges: Badge[] = [];
    for (const thread of threads) {
      noteComments(thread.comments.nodes);
      const comments = [...thread.comments.nodes].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      if (comments.length === 0) continue;

      const latest = comments[comments.length - 1];
      const latestAuthor = latest.author?.login?.toLowerCase();
      if (!latestAuthor || latestAuthor === meLower) continue; // you have the last word

      if (thread.isResolved || thread.isOutdated) {
        const mentionsMe = latest.body.toLowerCase().includes(mentionTag);
        if (!mentionsMe) continue;
      }

      prBadges.push({
        icon: isBot(latestAuthor) ? "🐛" : "💬",
        url: latest.url,
        createdAt: latest.createdAt,
        repo: `${owner}/${repo}`,
        prNumber: item.number,
        author: meLower,
      });
    }

    prBadgeCache.set(cacheKey, { updatedAt: item.updated_at, badges: prBadges });
    badges.push(...prBadges);
  }

  return { badges, errors };
}

// ---- category 2: other people's PRs — threads you've commented in ----

async function fetchParticipatingBadges(
  meLower: string,
  mentionTag: string,
  dueForForceRefresh: boolean
): Promise<{ badges: Badge[]; errors: string[] }> {
  const items = await searchPRs(`is:pr is:open commenter:${meLower} -author:${meLower}`);
  const badges: Badge[] = [];
  const errors: string[] = [];

  for (const item of items) {
    const [owner, repo] = repoOwnerFromUrl(item.repository_url);
    const prAuthorLower = item.user?.login?.toLowerCase();
    const cacheKey = `participating:${owner}/${repo}#${item.number}`;
    const cached = prBadgeCache.get(cacheKey);

    // Only bypass the cache here if it's actually due AND this PR currently
    // holds a badge that a reaction could silently resolve. Everything else
    // relies purely on updated_at, same as the own-PR category.
    const mustRecheckForReaction = dueForForceRefresh && activeParticipatingKeys.has(cacheKey);

    if (!mustRecheckForReaction && cached && cached.updatedAt === item.updated_at) {
      badges.push(...cached.badges);
      if (cached.badges.length > 0) activeParticipatingKeys.add(cacheKey);
      else activeParticipatingKeys.delete(cacheKey);
      continue; // unchanged since last poll — skip the GraphQL call entirely
    }

    let threads: ReviewThread[];
    try {
      threads = await fetchReviewThreads(owner, repo, item.number);
    } catch (err) {
      errors.push(`${owner}/${repo}#${item.number}: ${(err as Error).message}`);
      continue;
    }

    const prBadges: Badge[] = [];
    for (const thread of threads) {
      noteComments(thread.comments.nodes);
      const comments = [...thread.comments.nodes].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      if (comments.length === 0) continue;

      const iInvolved = comments.some((c) => c.author?.login?.toLowerCase() === meLower);
      if (!iInvolved) continue;

      const latest = comments[comments.length - 1];
      const latestAuthor = latest.author?.login?.toLowerCase();
      if (!latestAuthor) continue;

      if (latestAuthor === meLower) {
        // you have the last word — you're the one waiting on a reply
        if (thread.isResolved || thread.isOutdated) continue; // closed/stale, nothing left to watch

        // specifically the PR AUTHOR 👍-ing your comment counts as a soft
        // resolution — they've signaled agreement without needing to write
        // a reply. A 👍 from some other commenter doesn't carry the same
        // weight, so it doesn't clear the badge.
        const authorReacted =
          prAuthorLower != null &&
          latest.reactions.nodes.some((r) => r.user?.login?.toLowerCase() === prAuthorLower);
        if (authorReacted) continue;

        prBadges.push({
          icon: "🗣️",
          url: latest.url,
          createdAt: latest.createdAt,
          repo: `${owner}/${repo}`,
          prNumber: item.number,
          author: item.user?.login,
        });
      } else {
        // someone replied to you — a 👍 from you on their reply counts as
        // "acknowledged, no reply needed" and clears it, regardless of
        // GitHub's own resolved state
        const iReacted = latest.reactions.nodes.some(
          (r) => r.user?.login?.toLowerCase() === meLower
        );
        if (iReacted) continue;

        if (thread.isResolved || thread.isOutdated) {
          const mentionsMe = latest.body.toLowerCase().includes(mentionTag);
          if (!mentionsMe) continue;
        }
        prBadges.push({
          icon: isBot(latestAuthor) ? "🐛" : "👥",
          url: latest.url,
          createdAt: latest.createdAt,
          repo: `${owner}/${repo}`,
          prNumber: item.number,
          author: item.user?.login,
        });
      }
    }

    prBadgeCache.set(cacheKey, { updatedAt: item.updated_at, badges: prBadges });
    badges.push(...prBadges);
    if (prBadges.length > 0) activeParticipatingKeys.add(cacheKey);
    else activeParticipatingKeys.delete(cacheKey);
  }

  return { badges, errors };
}

// ---- category 3: pending review requests — PRs where you're a requested
// reviewer. GitHub clears you from this list automatically once you submit
// a formal review, but a plain comment (not submitted as a review) doesn't
// clear it — so we explicitly check for either before showing a badge.

async function hasActedOnPR(
  owner: string,
  repo: string,
  number: number,
  meLower: string
): Promise<boolean> {
  try {
    const [issueComments, reviewComments, reviews] = await Promise.all([
      gh<{ user: { login: string } | null }[]>(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`),
      gh<{ user: { login: string } | null }[]>(`/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`),
      gh<{ user: { login: string } | null }[]>(`/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`),
    ]);
    const authored = (items: { user: { login: string } | null }[]) =>
      items.some((c) => c.user?.login?.toLowerCase() === meLower);
    return authored(issueComments) || authored(reviewComments) || authored(reviews);
  } catch {
    return false; // fail open toward SHOWING the badge — better to nag about
    // a pending review than silently drop one because of a fetch error
  }
}

// `review-requested:` matches requests made to any team you're in, not just to
// you. Being added to lead-reviewers turned that into a stream of PRs nobody asked
// ME to look at, so those get their own icon instead of 👀. A PR that also names
// you directly stays 👀 — the direct ask is the stronger signal. Other teams you're
// in (engineering, deployment) are left as 👀 on purpose: they weren't the problem.
// Lead-only PRs that already have LEAD_REVIEW_APPROVALS approvals are dropped
// outright: the team request never clears on its own once enough leads have signed
// off, so they piled up faster than the queue could be worked.
const LEAD_REVIEW_TEAM = "Popmenu/lead-reviewers";
const LEAD_REVIEW_ICON = "👔";
const LEAD_REVIEW_APPROVALS = 2;

// The lead-team search is GraphQL rather than REST so one call returns each PR's
// approval count too. latestReviews is one review per author (their most recent),
// so an approval later superseded by a change request doesn't count, and nobody
// counts twice. Counted directly rather than read off reviewDecision: that stays
// REVIEW_REQUIRED while a CODEOWNERS team is still outstanding, even at 3 approvals.
const LEAD_REVIEW_SEARCH_QUERY = `
  query($q: String!) {
    search(query: $q, type: ISSUE, first: 100) {
      nodes {
        ... on PullRequest {
          url
          latestReviews(first: 50) { nodes { state } }
        }
      }
    }
    rateLimit { cost remaining limit resetAt }
  }
`;

async function fetchLeadReviewApprovals(): Promise<Map<string, number>> {
  const data = await ghGraphQL<{
    search: { nodes: ({ url: string; latestReviews: { nodes: { state: string }[] } } | Record<string, never>)[] };
    rateLimit: RateLimitInfo | null;
  }>(LEAD_REVIEW_SEARCH_QUERY, { q: `is:pr is:open team-review-requested:${LEAD_REVIEW_TEAM}` });
  if (data.rateLimit) lastKnownRateLimit = data.rateLimit;
  const approvals = new Map<string, number>();
  for (const pr of data.search.nodes) {
    if (!("url" in pr)) continue;
    approvals.set(pr.url, pr.latestReviews.nodes.filter((r) => r.state === "APPROVED").length);
  }
  return approvals;
}

async function fetchReviewRequestBadges(meLower: string): Promise<{ badges: Badge[]; errors: string[] }> {
  const [items, direct, leadApprovals] = await Promise.all([
    searchPRs(`is:pr is:open review-requested:${meLower}`),
    searchPRs(`is:pr is:open user-review-requested:${meLower}`),
    fetchLeadReviewApprovals(),
  ]);
  const directUrls = new Set(direct.map((i) => i.html_url));
  const leadOnlyUrls = new Set([...leadApprovals.keys()].filter((u) => !directUrls.has(u)));
  const fullyApproved = (item: SearchItem) =>
    leadOnlyUrls.has(item.html_url) && (leadApprovals.get(item.html_url) ?? 0) >= LEAD_REVIEW_APPROVALS;
  // Applied on cache hits too: adding a direct request on top of the team one
  // isn't guaranteed to move updated_at, so the icon can't be frozen in the cache.
  const iconFor = (item: SearchItem) => (leadOnlyUrls.has(item.html_url) ? LEAD_REVIEW_ICON : "👀");
  const badges: Badge[] = [];
  const errors: string[] = [];

  // Checked before the cache and the per-PR REST calls: a fully-approved lead PR
  // costs nothing beyond the one search above.
  for (const item of items.filter((i) => !fullyApproved(i))) {
    const [owner, repo] = repoOwnerFromUrl(item.repository_url);
    const cacheKey = `reviewrequest:${owner}/${repo}#${item.number}`;
    const cached = prBadgeCache.get(cacheKey);

    if (cached && cached.updatedAt === item.updated_at) {
      badges.push(...cached.badges.map((b) => ({ ...b, icon: iconFor(item) })));
      continue; // unchanged since last poll — skip the extra API calls entirely
    }

    let acted: boolean;
    try {
      acted = await hasActedOnPR(owner, repo, item.number, meLower);
    } catch (err) {
      errors.push(`${owner}/${repo}#${item.number}: ${(err as Error).message}`);
      continue;
    }

    const prBadges: Badge[] = acted
      ? []
      : [
          {
            icon: iconFor(item),
            url: `https://github.com/${owner}/${repo}/pull/${item.number}/files`,
            createdAt: item.updated_at,
            repo: `${owner}/${repo}`,
            prNumber: item.number,
            author: item.user?.login,
          },
        ];

    prBadgeCache.set(cacheKey, { updatedAt: item.updated_at, badges: prBadges });
    badges.push(...prBadges);
  }

  return { badges, errors };
}

// ---- category 3b: someone @-mentioned you ----
//
// Why this exists as its own category: every other badge is derived from
// reviewThreads, so a mention in the PR's CONVERSATION TIMELINE produced nothing at
// all — and that's where mentions overwhelmingly land. Worse, the participating
// category skips any review thread you haven't yourself commented in (its iInvolved
// check), so a mention in a thread you'd never spoken in was dropped there too. Both
// holes are covered here.
//
// `mentions:` is the right search qualifier and it does match mentions inside
// COMMENTS, not just the PR body — verified against a live PR whose body doesn't
// name me but which the search still returns. So one search finds every case.
//
// Overlap with the other categories is deliberate and cheap: a PR can legitimately
// show 👥 (a reply to you) AND 📣 (you were named somewhere else). They group under
// one PR cluster, so it reads as two signals on one PR rather than duplicates. The
// one true duplicate — a review-thread comment that @s you in a thread you're
// already in — is excluded below, since participating already badges that.
const MENTION_ICON = "📣";

async function fetchMentionBadges(
  meLower: string,
  mentionTag: string,
  dueForForceRefresh: boolean
): Promise<{ badges: Badge[]; errors: string[] }> {
  const items = await searchPRs(`is:pr is:open mentions:${meLower}`);
  const badges: Badge[] = [];
  const errors: string[] = [];

  for (const item of items) {
    const [owner, repo] = repoOwnerFromUrl(item.repository_url);
    const cacheKey = `mention:${owner}/${repo}#${item.number}`;
    const cached = prBadgeCache.get(cacheKey);

    // Only bypass the cache when a refresh is actually due AND this PR holds a live
    // 📣 that a reaction could have silently cleared.
    const mustRecheckForReaction = dueForForceRefresh && activeMentionKeys.has(cacheKey);

    if (!mustRecheckForReaction && cached && cached.updatedAt === item.updated_at) {
      badges.push(...cached.badges);
      if (cached.badges.length > 0) activeMentionKeys.add(cacheKey);
      else activeMentionKeys.delete(cacheKey);
      continue; // unchanged since last poll — skip the GraphQL call entirely
    }

    let data: PRMentionsData;
    try {
      data = await ghGraphQL<PRMentionsData>(MENTIONS_QUERY, { owner, repo, number: item.number });
    } catch (err) {
      errors.push(`${owner}/${repo}#${item.number}: ${(err as Error).message}`);
      continue;
    }
    if (data.rateLimit) lastKnownRateLimit = data.rateLimit;
    const pr = data.repository?.pullRequest;
    if (!pr) continue;

    const mine = (c: MentionComment) => c.author?.login?.toLowerCase() === meLower;
    const mentionsMe = (c: MentionComment) =>
      !mine(c) && c.author != null && c.body.toLowerCase().includes(mentionTag);

    // Timeline mentions always count. Review-thread mentions count only in threads
    // I haven't commented in — the rest belong to the participating category, and
    // badging them here too would double up on the same comment.
    const candidates: MentionComment[] = [
      ...pr.comments.nodes.filter(mentionsMe),
      ...pr.reviewThreads.nodes
        .filter((t) => !t.comments.nodes.some(mine))
        .flatMap((t) => t.comments.nodes.filter(mentionsMe)),
    ];
    if (candidates.length === 0) {
      prBadgeCache.set(cacheKey, { updatedAt: item.updated_at, badges: [] });
      activeMentionKeys.delete(cacheKey);
      continue;
    }

    // One badge per PR, pointed at the NEWEST mention. Being named five times in a
    // thread is still one thing to go read, and per-mention badges would swamp the
    // row — unlike 💬/👥, which are per-thread precisely because each thread is a
    // separate conversation to answer.
    const newest = candidates.reduce((a, b) =>
      new Date(a.createdAt) > new Date(b.createdAt) ? a : b
    );

    // Cleared by replying anywhere on the PR after the mention, or by any reaction
    // from me on the mentioning comment itself (same acknowledged-no-reply-needed
    // convention the participating category already uses for 👍).
    const mentionAt = new Date(newest.createdAt).getTime();
    const myLatestActivity = [
      ...pr.comments.nodes,
      ...pr.reviewThreads.nodes.flatMap((t) => t.comments.nodes),
    ]
      .filter(mine)
      .reduce((max, c) => Math.max(max, new Date(c.createdAt).getTime()), 0);
    const repliedSince = myLatestActivity > mentionAt;
    const iReacted = newest.reactionGroups.some((g) => g.viewerHasReacted);

    const prBadges: Badge[] =
      repliedSince || iReacted
        ? []
        : [
            {
              icon: isBot(newest.author!.login.toLowerCase()) ? "🐛" : MENTION_ICON,
              url: newest.url,
              createdAt: newest.createdAt,
              repo: `${owner}/${repo}`,
              prNumber: item.number,
              author: item.user?.login,
            },
          ];

    prBadgeCache.set(cacheKey, { updatedAt: item.updated_at, badges: prBadges });
    badges.push(...prBadges);
    if (prBadges.length > 0) activeMentionKeys.add(cacheKey);
    else activeMentionKeys.delete(cacheKey);
  }

  return { badges, errors };
}

// ---- category 3c: your team's PRs awaiting review ----
//
// Driven by SHORTCUT, not GitHub, and that's the whole point. The GitHub-side
// framings of "PRs my team needs reviewed" are unusable: every open PR in popmenu is
// 153, dropping your own leaves 144, and even filtering to non-draft/untouched/
// updated-this-week leaves 65 — dozens of badges in a 2-line pane. The Shortcut
// framing ("tickets sitting in MY TEAM's Ready for Review column") is 3 stories, and
// after filtering, 1 badge. Same question, three orders of magnitude less noise.
//
// The filter chain matters more than the search here:
//   archived    — the Shortcut UI HIDES archived stories, so a raw
//                 group+state search returns a pile of long-dead tickets that
//                 aren't in the column you're looking at. 9 of 12, when this was
//                 written. Filtering this is not optional.
//   approved    — decided on GITHUB, not on Shortcut's review_status, because
//                 this repo needs TWO approvals and Shortcut flips to "approved"
//                 after the first. Clears when the PR is fully approved OR when
//                 YOU have approved it. See filterUnapprovedOnGitHub.
//   merged/closed/draft — nothing to review on any of those.
//   own branch  — see MY_BRANCH_PREFIX.
//
// Self-clearing, unlike 📣: the badge disappears when the story leaves Ready for
// Review, which is exactly the team's own definition of "done being reviewed". No
// reaction-polling or force-refresh needed.
const TEAM_REVIEW_ICON = "🤝";

interface ScStory {
  id: number;
  archived: boolean;
  updated_at: string;
}

interface ScPullRequest {
  number: number;
  url: string;
  branch_name?: string;
  review_status?: string;
  merged?: boolean;
  closed?: boolean;
  draft?: boolean;
  updated_at?: string;
}

async function shortcut<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SHORTCUT_API}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Shortcut-Token": SHORTCUT_TOKEN as string,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// Team + workflow-state ids, looked up once per process from their configured NAMES.
// Both are workspace configuration that doesn't change while the widget runs.
let scIds: { groupId: string; stateIds: number[] } | null = null;

// Collects EVERY state matching those names, across every workflow — it does not
// stop at the first hit. The workspace has two states that trim to "Ready for
// Review": one in Delivery and one in Data (the Data one has a trailing space).
// A first-match-wins lookup silently binds to whichever workflow the API happens
// to list first, which is a wrong answer that looks exactly like a right one.
async function resolveScIds(): Promise<{ groupId: string; stateIds: number[] } | null> {
  if (scIds) return scIds;
  const groups = await shortcut<{ id: string; name: string; archived: boolean }[]>("/groups");
  const group = groups.find((g) => !g.archived && g.name === SC_TEAM_NAME);
  if (!group) return null;

  const workflows = await shortcut<{ states: { id: number; name: string }[] }[]>("/workflows");
  const stateIds = workflows.flatMap((w) =>
    w.states.filter((s) => SC_REVIEW_STATE_NAMES.includes(s.name.trim())).map((s) => s.id),
  );
  if (!stateIds.length) return null;

  scIds = { groupId: group.id, stateIds };
  return scIds;
}

// Story id → the CANDIDATE PRs it contributed, keyed on the story's updated_at,
// so an unchanged story skips its detail fetch entirely (same trick as
// prBadgeCache).
//
// Candidates, not finished badges — and that distinction is the fix for a real
// bug. Whether a PR still needs review is decided on GITHUB (see the block
// below), and a GitHub approval does not move a Shortcut story's updated_at.
// Caching the finished badge meant an approval could land and the badge would
// sit there until something unrelated touched the ticket.
const scStoryCache = new Map<number, { updatedAt: string; prs: TeamReviewCandidate[] }>();

interface TeamReviewCandidate {
  prNumber: number;
  url: string;
  repo: string;
  updatedAt: string;
  author?: string; // filled in by filterUnapprovedOnGitHub — Shortcut doesn't know it
}

// ---- the approval gate ----
//
// This does NOT use Shortcut's `review_status`, and that is deliberate.
//
// Popmenu/popmenu requires TWO approvals. Shortcut flips `review_status` to
// "approved" on the FIRST one, so it reports "somebody approved this", not "this
// PR is done being reviewed" — those are different facts and only the second one
// belongs in a review queue. Measured live: PR #35714 read `approved` in Shortcut
// while GitHub still said REVIEW_REQUIRED, so it vanished from this panel while
// it was in fact waiting on a second reviewer. Exactly backwards.
//
// GitHub's `reviewDecision` is the branch-protection verdict itself, so it counts
// required reviewers, CODEOWNERS and dismissed-stale-review rules for free.
// One aliased query for every candidate, uncached — an approval is precisely the
// event we must not miss, so paying ~1 point per open team PR per poll is the
// point rather than an oversight.
//
// TWO conditions clear a badge, because "the team still needs a review" and "I
// still need to review" are different questions and this panel asks the second:
//   reviewDecision === APPROVED    the PR is fully reviewed, nobody need act.
//   viewerLatestReview APPROVED    YOU already approved it. Under a two-approval
//     requirement your approval leaves reviewDecision at REVIEW_REQUIRED, so
//     without this clause a PR you had just signed off on would sit in your queue
//     until a second reviewer turned up — precisely backwards.
// `viewerLatestReview` is GitHub resolving "your latest review" itself, so it
// needs no login constant and already handles a later CHANGES_REQUESTED
// superseding an earlier approval.
async function filterUnapprovedOnGitHub(
  candidates: TeamReviewCandidate[],
): Promise<{ kept: TeamReviewCandidate[]; errors: string[] }> {
  if (!candidates.length) return { kept: [], errors: [] };

  const query = `query {
    ${candidates
      .map((c, i) => {
        const [owner, repo] = c.repo.split("/");
        return `p${i}: repository(owner: "${owner}", name: "${repo}") { pullRequest(number: ${c.prNumber}) { reviewDecision viewerLatestReview { state } author { login } } }`;
      })
      .join("\n")}
    rateLimit { cost remaining limit resetAt }
  }`;

  let data: Record<string, unknown>;
  try {
    data = await ghGraphQL<Record<string, unknown>>(query, {});
  } catch (err) {
    // Fail OPEN: if GitHub can't be reached, show the badges rather than
    // silently emptying the category. A stale 🤝 is a wasted click; a missing
    // one is a PR nobody looks at.
    return { kept: candidates, errors: [`team review decision: ${(err as Error).message}`] };
  }

  const rl = data.rateLimit as RateLimitInfo | null;
  if (rl) lastKnownRateLimit = rl;

  const kept = candidates.filter((c, i) => {
    const node = data[`p${i}`] as {
      pullRequest: {
        reviewDecision: string | null;
        viewerLatestReview: { state: string } | null;
        author: { login: string } | null;
      } | null;
    } | null;
    const pr = node?.pullRequest;
    c.author = pr?.author?.login;
    // A null decision means the repo has no review requirement at all — nothing
    // is gating it, so nothing marks it reviewed either. Keep it.
    if (pr?.reviewDecision === "APPROVED") return false;
    if (pr?.viewerLatestReview?.state === "APPROVED") return false;
    return true;
  });
  return { kept, errors: [] };
}

async function fetchTeamReviewBadges(): Promise<{ badges: Badge[]; errors: string[] }> {
  const badges: Badge[] = [];
  const errors: string[] = [];
  if (!SHORTCUT_TOKEN) return { badges, errors };

  let ids: { groupId: string; stateIds: number[] } | null;
  try {
    ids = await resolveScIds();
  } catch (err) {
    return { badges, errors: [`shortcut ids: ${(err as Error).message}`] };
  }
  if (!ids) {
    return { badges, errors: [`shortcut: no team "${SC_TEAM_NAME}" / states ${SC_REVIEW_STATE_NAMES.join(", ")}`] };
  }

  // One search per state — the search endpoint takes a single workflow_state_id.
  // Deduped by story id because a story can only be in one state, but a state id
  // could in principle repeat across workflows.
  let stories: ScStory[];
  try {
    const perState = await Promise.all(
      ids.stateIds.map((stateId) =>
        shortcut<ScStory[]>("/stories/search", { group_id: ids!.groupId, workflow_state_id: stateId }),
      ),
    );
    const byId = new Map<number, ScStory>();
    for (const s of perState.flat()) byId.set(s.id, s);
    stories = [...byId.values()];
  } catch (err) {
    return { badges, errors: [`shortcut search: ${(err as Error).message}`] };
  }

  // The one filter that isn't obvious — see the comment above.
  const live = stories.filter((s) => !s.archived);

  const candidates: TeamReviewCandidate[] = [];
  const seenPrs = new Set<number>(); // one story's PR can be attached to another's

  for (const story of live) {
    const cached = scStoryCache.get(story.id);
    let storyPrs: TeamReviewCandidate[];

    if (cached && cached.updatedAt === story.updated_at) {
      storyPrs = cached.prs;
    } else {
      let detail: { pull_requests?: ScPullRequest[] };
      try {
        detail = await shortcut(`/stories/${story.id}`);
      } catch (err) {
        errors.push(`sc-${story.id}: ${(err as Error).message}`);
        continue;
      }

      storyPrs = [];
      for (const pr of detail.pull_requests ?? []) {
        // Everything here is a property of the PR itself, cheap and stable —
        // unlike approval state, which is why it is gated on GitHub below.
        if (pr.merged || pr.closed || pr.draft) continue;
        if ((pr.branch_name ?? "").startsWith(MY_BRANCH_PREFIX)) continue;
        const repoMatch = pr.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//);
        storyPrs.push({
          prNumber: pr.number,
          url: pr.url,
          repo: repoMatch ? repoMatch[1] : "",
          updatedAt: pr.updated_at ?? story.updated_at,
        });
      }
      scStoryCache.set(story.id, { updatedAt: story.updated_at, prs: storyPrs });
    }

    for (const c of storyPrs) {
      if (seenPrs.has(c.prNumber)) continue;
      seenPrs.add(c.prNumber);
      candidates.push(c);
    }
  }

  const { kept, errors: gateErrors } = await filterUnapprovedOnGitHub(candidates.filter((c) => c.repo));
  errors.push(...gateErrors);

  for (const c of kept) {
    badges.push({
      icon: TEAM_REVIEW_ICON,
      url: c.url,
      createdAt: c.updatedAt,
      repo: c.repo,
      prNumber: c.prNumber,
      author: c.author,
    });
  }

  return { badges, errors };
}

// ---- category 4: QA app status on your own PRs ----
// QA engineers spin up a QA environment for a ticket by leaving a top-level
// PR comment (some variation of "qa app deploy") and tear it down with
// "qa app destroy" once the ticket has passed QA. We surface the LATEST
// such command as a badge — 👷 while deployed, ✅ once destroyed (passed).
// Matching is intentionally loose on separators so "qa app deploy",
// "qa-app-deploy", "/qa app deploy", etc. all count; the deploy/destroy
// keyword is what distinguishes the two states.

const QA_DEPLOY_RE = /qa[\s\-_/]*app[\s\-_/]*deploy/i;
const QA_DESTROY_RE = /qa[\s\-_/]*app[\s\-_/]*destroy/i;

interface IssueComment {
  user: { login: string } | null;
  created_at: string;
  body: string;
  html_url: string;
}

async function fetchQABadges(meLower: string): Promise<{ badges: Badge[]; errors: string[] }> {
  const items = await searchPRs(`is:pr is:open author:${meLower}`);
  const badges: Badge[] = [];
  const errors: string[] = [];

  for (const item of items) {
    const [owner, repo] = repoOwnerFromUrl(item.repository_url);
    const cacheKey = `qa:${owner}/${repo}#${item.number}`;
    const cached = prBadgeCache.get(cacheKey);

    // A qa-app comment bumps the PR's updated_at, so the same updated_at
    // guard used everywhere else lets us skip idle PRs entirely.
    if (cached && cached.updatedAt === item.updated_at) {
      badges.push(...cached.badges);
      continue;
    }

    let comments: IssueComment[];
    try {
      comments = await gh<IssueComment[]>(
        `/repos/${owner}/${repo}/issues/${item.number}/comments?per_page=100`
      );
    } catch (err) {
      errors.push(`${owner}/${repo}#${item.number}: ${(err as Error).message}`);
      continue;
    }

    // Find the most recent comment that carries a qa-app command. The API
    // returns issue comments oldest-first, but sort defensively rather than
    // rely on that ordering.
    let latest: { comment: IssueComment; kind: "deploy" | "destroy" } | null = null;
    for (const c of comments) {
      const body = c.body ?? "";
      const isDestroy = QA_DESTROY_RE.test(body);
      const isDeploy = QA_DEPLOY_RE.test(body);
      if (!isDestroy && !isDeploy) continue;
      if (!latest || new Date(c.created_at).getTime() >= new Date(latest.comment.created_at).getTime()) {
        // destroy wins if a single comment somehow mentions both — ✅ (passed)
        // is the more terminal state
        latest = { comment: c, kind: isDestroy ? "destroy" : "deploy" };
      }
    }

    const prBadges: Badge[] = latest
      ? [
          {
            icon: latest.kind === "destroy" ? "✅" : "👷",
            url: latest.comment.html_url,
            createdAt: latest.comment.created_at,
            repo: `${owner}/${repo}`,
            prNumber: item.number,
            author: meLower,
          },
        ]
      : [];

    prBadgeCache.set(cacheKey, { updatedAt: item.updated_at, badges: prBadges });
    badges.push(...prBadges);
  }

  return { badges, errors };
}

async function fetchBadges(): Promise<{ badges: Badge[]; errors: string[] }> {
  const me = await getUsername();
  const meLower = me.toLowerCase();
  myLoginLower = meLower;
  const mentionTag = `@${meLower}`;

  // Resolved once and shared — see shouldForceRefresh: two categories calling it
  // concurrently would race for the single refresh slot.
  const dueForForceRefresh = shouldForceRefresh();

  const [own, participating, reviewRequests, mentions, teamReview, qa] = await Promise.all([
    fetchOwnPRBadges(meLower, mentionTag),
    fetchParticipatingBadges(meLower, mentionTag, dueForForceRefresh),
    fetchReviewRequestBadges(meLower),
    fetchMentionBadges(meLower, mentionTag, dueForForceRefresh),
    fetchTeamReviewBadges(),
    fetchQABadges(meLower),
  ]);

  const gathered = [
    ...own.badges,
    ...participating.badges,
    ...reviewRequests.badges,
    ...mentions.badges,
    ...teamReview.badges,
    ...qa.badges,
  ];
  const { kept: all, errors: labelErrors } = await dropDoNotMerge(gathered);
  all.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return {
    badges: all,
    errors: [
      ...own.errors,
      ...participating.errors,
      ...reviewRequests.errors,
      ...mentions.errors,
      ...teamReview.errors,
      ...qa.errors,
      ...labelErrors,
    ],
  };
}

// PRs labelled DoNotMerge are omitted entirely, from every category, mine
// included: nobody is meant to act on them yet.
//
// Checked once per poll over every PR that has a badge, as one aliased query
// (~1 point), rather than per category. Half the categories never see a label:
// the team queue comes from Shortcut and the lead count from its own search.
// Uncached for the same reason the approval gate is: a label going on or coming
// off is exactly the change the pane must reflect on the next poll.
const DO_NOT_MERGE_LABEL = "donotmerge";

// PRs YOU have approved (your latest review is APPROVED), as "owner/repo#123".
// Rides on the same per-poll query as the label check, so it costs nothing
// extra; clusterLines draws these PR numbers in dim green.
let approvedByMe = new Set<string>();

async function dropDoNotMerge(badges: Badge[]): Promise<{ kept: Badge[]; errors: string[] }> {
  const prs = [...new Map(badges.map((b) => [`${b.repo}#${b.prNumber}`, b])).values()];
  if (!prs.length) return { kept: badges, errors: [] };
  const query = `query {
    ${prs
      .map((b, i) => {
        const [owner, repo] = b.repo.split("/");
        return `p${i}: repository(owner: "${owner}", name: "${repo}") { pullRequest(number: ${b.prNumber}) { labels(first: 30) { nodes { name } } viewerLatestReview { state } } }`;
      })
      .join("\n")}
  }`;
  let data: Record<
    string,
    { pullRequest: { labels: { nodes: { name: string }[] }; viewerLatestReview: { state: string } | null } | null } | null
  >;
  try {
    data = await ghGraphQL(query, {});
  } catch (err) {
    // Fail OPEN: showing a DoNotMerge PR is a wasted glance, hiding everything is worse.
    return { kept: badges, errors: [`labels: ${(err as Error).message}`] };
  }
  const blocked = new Set<string>();
  const approved = new Set<string>();
  prs.forEach((b, i) => {
    // viewerLatestReview is GitHub resolving "your most recent review", so an
    // approval you later superseded with a change request doesn't count.
    if (data[`p${i}`]?.pullRequest?.viewerLatestReview?.state === "APPROVED") approved.add(`${b.repo}#${b.prNumber}`);
    const labels = data[`p${i}`]?.pullRequest?.labels.nodes ?? [];
    if (labels.some((l) => l.name.replace(/[\s_-]/g, "").toLowerCase() === DO_NOT_MERGE_LABEL)) {
      blocked.add(`${b.repo}#${b.prNumber}`);
    }
  });
  approvedByMe = approved;
  return { kept: badges.filter((b) => !blocked.has(`${b.repo}#${b.prNumber}`)), errors: [] };
}

interface PRCluster {
  key: string;
  repo: string;
  prNumber: number;
  badges: Badge[];
  latestCreatedAt: string;
  // Set only on a collapsed 👔 row: the per-PR clusters it stands in for, and
  // whose PRs they are. See collapseLeadReviews.
  members?: PRCluster[];
  author?: string;
}

// group badges by PR so related signals (e.g. a review request AND a reply
// on the same PR) sit together instead of scattering across the row with
// no indication they're related
function groupByPR(badges: Badge[]): PRCluster[] {
  const groups = new Map<string, Badge[]>();
  for (const b of badges) {
    const key = `${b.repo}#${b.prNumber}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(b);
  }

  const clusters: PRCluster[] = Array.from(groups.entries()).map(([key, group]) => {
    const latest = group.reduce((a, b) => (new Date(a.createdAt) > new Date(b.createdAt) ? a : b));
    return {
      key,
      repo: group[0].repo,
      prNumber: group[0].prNumber,
      badges: group,
      latestCreatedAt: latest.createdAt,
    };
  });

  clusters.sort((a, b) => new Date(a.latestCreatedAt).getTime() - new Date(b.latestCreatedAt).getTime());
  return clusters;
}

// One dev opening a stack of PRs fans out a 👔 per PR, and with one row per PR
// that buried the whole pane. So a dev's lead-only PRs fold into a single row once
// there are LEAD_COLLAPSE_MIN of them. Only clusters that are NOTHING but 👔 fold:
// a PR that also carries a reply or a direct ask stays on its own row, because
// that badge is about you and must not hide inside someone else's batch.
const LEAD_COLLAPSE_MIN = 2;

function collapseLeadReviews(clusters: PRCluster[]): PRCluster[] {
  const byAuthor = new Map<string, PRCluster[]>();
  for (const c of clusters) {
    const author = c.badges[0].author;
    if (!author || !c.badges.every((b) => b.icon === LEAD_REVIEW_ICON)) continue;
    if (!byAuthor.has(author)) byAuthor.set(author, []);
    byAuthor.get(author)!.push(c);
  }

  const folded = new Set<PRCluster>();
  const rows: PRCluster[] = [];
  for (const [author, members] of byAuthor) {
    if (members.length < LEAD_COLLAPSE_MIN) continue;
    for (const m of members) folded.add(m);
    const newest = members[members.length - 1]; // clusters arrive sorted oldest-first
    rows.push({
      key: `lead:${author}`,
      repo: newest.repo,
      prNumber: newest.prNumber,
      badges: members.flatMap((m) => m.badges),
      latestCreatedAt: newest.latestCreatedAt,
      members,
      author,
    });
  }
  if (!rows.length) return clusters;

  return [...clusters.filter((c) => !folded.has(c)), ...rows].sort(
    (a, b) => new Date(a.latestCreatedAt).getTime() - new Date(b.latestCreatedAt).getTime(),
  );
}

function clusterText(cluster: PRCluster): string {
  return clusterLines(cluster, Infinity)[0];
}

// A PR's row, wrapped to `width` cells. Badges that don't fit continue on the
// next line, indented under the first badge:
//   #37322  💬 1d 💬 1d
//           💬 1d 💬 1d
// Only the two-column layout passes a finite width; a single badge or a
// collapsed 👔 row is never broken, so a line can still exceed `width` — the
// caller checks and falls back to one column.
function clusterLines(cluster: PRCluster, width: number): string[] {
  if (cluster.members) {
    const q = `is:pr is:open team-review-requested:${LEAD_REVIEW_TEAM} author:${cluster.author}`;
    const searchUrl = `https://github.com/pulls?q=${encodeURIComponent(q)}`;
    return [`${LEAD_REVIEW_ICON} ${webLink(`${cluster.author} ×${cluster.members.length}`, searchUrl)} ${formatAge(cluster.latestCreatedAt)}`];
  }
  const prUrl = `https://github.com/${cluster.repo}/pull/${cluster.prNumber}`;
  const tag = sectionOf(cluster) === "team" ? ` ${effortTag(clusterEffort(cluster))}` : "";
  // Dim green PR number = you have approved this PR. Colour goes inside the
  // link text so the hyperlink wraps it intact.
  const num = approvedByMe.has(cluster.key) ? `${DIM}${GREEN}#${cluster.prNumber}${RESET}` : `#${cluster.prNumber}`;
  const head = `${webLink(num, prUrl)}${tag}  `;
  const indent = " ".repeat(visibleWidth(head));
  const lines: string[] = [];
  let line = head;
  let lineHasBadge = false;
  for (const b of cluster.badges) {
    const part = `${b.icon} ${webLink(formatAge(b.createdAt), b.url)}`;
    const candidate = lineHasBadge ? `${line} ${part}` : `${line}${part}`;
    if (lineHasBadge && visibleWidth(candidate) > width) {
      lines.push(line);
      line = `${indent}${part}`;
    } else {
      line = candidate;
    }
    lineHasBadge = true;
  }
  lines.push(line);
  return lines;
}

// one line per PR, always — keep the newest N if there isn't enough
// vertical room for all of them
// The pane is only as tall as tmux made it, so the oldest clusters fall off the
// top. Pulled out of packClusters because the PR list written for `termdash
// open-prs` has to be EXACTLY what is on screen — "open all the PRs in the pane"
// is a lie if it also opens three you cannot see.
// `fromHead` keeps the FIRST rows instead: the team section is sorted by effort,
// not age, and the rows worth keeping there are the cheap reviews at the top.
// `height` is how many lines a cluster takes: 1 unless the two-column layout
// wrapped it. Clusters are kept contiguously from the kept end until the next
// one would not fit.
type Height = (c: PRCluster) => number;
const ONE_LINE: Height = () => 1;

function keptClusters(clusters: PRCluster[], maxRows: number, fromHead = false, height: Height = ONE_LINE): PRCluster[] {
  const order = fromHead ? clusters : [...clusters].reverse();
  const out: PRCluster[] = [];
  let used = 0;
  for (const c of order) {
    const h = height(c);
    if (used + h > maxRows) break;
    out.push(c);
    used += h;
  }
  return fromHead ? out : out.reverse();
}

function rowsOf(clusters: PRCluster[], height: Height): number {
  return clusters.reduce((n, c) => n + height(c), 0);
}

// ---- review effort (team section only) ----
// Each teammate PR gets a low/medium/high review-effort rating from a quick
// glance by headless Claude; pr-effort.ts owns the rating and its 30-day disk
// cache. The team section is sorted low → medium → high, with unrated rows
// (still being rated, or a collapsed 👔 row) last. Rows with the same rating keep
// their age order. Rating runs after the paint and is never awaited, so a new
// teammate PR shows as unrated (·) for one poll and then moves into place.
function clusterEffort(c: PRCluster): Effort | undefined {
  return c.members ? undefined : effortOf(c.repo, c.prNumber);
}

const GREEN = "\x1b[32m";
function effortTag(e: Effort | undefined): string {
  if (e === "low") return `${GREEN}L${RESET}`;
  if (e === "medium") return `${YELLOW}M${RESET}`;
  if (e === "high") return `${RED}H${RESET}`;
  return `${DIM}·${RESET}`;
}

function sortByEffort(clusters: PRCluster[]): PRCluster[] {
  const rank = (c: PRCluster) => {
    const e = clusterEffort(c);
    return e ? EFFORT_RANK[e] : 3;
  };
  return [...clusters].sort((a, b) => rank(a) - rank(b)); // stable: ties keep age order
}

function teamPRs(badges: Badge[]): { repo: string; prNumber: number }[] {
  return groupByPR(badges)
    .filter((c) => sectionOf(c) === "team")
    .map((c) => ({ repo: c.repo, prNumber: c.prNumber }));
}

// The pane is split into labelled sections, in this order:
//   mine   your own PRs — replies, bot comments, QA status
//   team   Marketeers' PRs, the work you're actually on the hook to review
//   other  everything else that needs you: direct asks, threads, mentions
//   lead   PRs that reached you only via the lead-reviewers team (all-👔 rows)
// A row's section comes from the PR's author, first match wins, so a teammate's
// lead-reviewers PR is "team", not "lead". Team logins are GitHub logins, not
// Shortcut mention names (shortcut-peers.ts's PEERS) — they differ for everyone.
const TEAM_LOGINS = new Set(["joseneto", "tsabz", "andrew-zimmer", "florescarol-popmenu"]);
let myLoginLower = ""; // set by fetchBadges; the mock sets its own

type SectionName = "mine" | "team" | "other" | "lead";
const SECTION_ORDER: SectionName[] = ["mine", "team", "other", "lead"];
// Who keeps their rows when the pane is too short: lead goes first, mine last.
const SECTION_PRIORITY: SectionName[] = ["mine", "team", "other", "lead"];

function sectionOf(c: PRCluster): SectionName {
  const author = (c.author ?? c.badges.find((b) => b.author)?.author)?.toLowerCase();
  if (author && author === myLoginLower) return "mine";
  if (author && TEAM_LOGINS.has(author)) return "team";
  if (c.badges.every((b) => b.icon === LEAD_REVIEW_ICON)) return "lead";
  return "other";
}

interface Section {
  name: SectionName;
  clusters: PRCluster[];
}

// Splits the row budget across the non-empty sections. Each rule between two
// sections costs a row. Every section is first given one row, so a short pane
// still shows that teammates are waiting; the rest go out in SECTION_PRIORITY
// order. Each section keeps its NEWEST rows. A section left with none is dropped
// along with its rule, and the split is redone.
function sectionize(clusters: PRCluster[], maxRows: number, height: Height = ONE_LINE): Section[] {
  let live = SECTION_ORDER.map((name) => {
    const own = clusters.filter((c) => sectionOf(c) === name);
    return { name, clusters: name === "team" ? sortByEffort(own) : own };
  }).filter(
    (s) => s.clusters.length,
  );
  // Too short for one row per section plus the rules between them: drop the
  // lowest-priority sections until it fits.
  while (live.length > 1 && live.length * 2 - 1 > maxRows) {
    const lowest = [...SECTION_PRIORITY].reverse().find((n) => live.some((s) => s.name === n));
    live = live.filter((s) => s.name !== lowest);
  }
  for (;;) {
    // `rows` is each section's line allowance, not its PR count — the same
    // thing until the two-column layout wraps a row onto two lines.
    let budget = maxRows - Math.max(live.length - 1, 0);
    const rows = new Map<SectionName, number>(live.map((s) => [s.name, 0]));
    const byPriority = SECTION_PRIORITY.map((n) => live.find((s) => s.name === n)).filter((s): s is Section => !!s);
    const keep = (s: Section, n: number) => keptClusters(s.clusters, n, s.name === "team", height);
    for (const sec of byPriority) {
      const first = rowsOf(keep(sec, 1 << 30).slice(sec.name === "team" ? 0 : -1).slice(0, 1), height);
      if (budget <= 0 || first > budget) continue;
      rows.set(sec.name, first);
      budget -= first;
    }
    for (const sec of byPriority) {
      const used = rowsOf(keep(sec, rows.get(sec.name)! + budget), height);
      budget -= used - rows.get(sec.name)!;
      rows.set(sec.name, used);
    }
    const kept = new Map(live.map((s) => [s.name, keep(s, rows.get(s.name)!)]));
    const next = live.map((s) => ({ name: s.name, clusters: kept.get(s.name)! }));
    if (next.every((s) => s.clusters.length) || next.length <= 1) return next.filter((s) => s.clusters.length);
    live = live.filter((s) => kept.get(s.name)!.length);
  }
}

// The rule between two sections names BOTH of them: "── ↑ mine · team ↓ ──".
// A header line above the first section isn't an option: render() must print
// a badge row first (see the note there), so the first section is labelled by
// the rule below it instead.
function sectionRule(above: SectionName, below: SectionName, width = Math.min(process.stdout.columns || 40, 40)): string {
  return ruleWith(` ↑ ${above} · ${below} ↓ `, width);
}

function ruleWith(label: string, width: number): string {
  const side = Math.max(Math.floor((width - label.length) / 2), 1);
  return `${DIM}${"─".repeat(side)}${label}${"─".repeat(side)}${RESET}`;
}

// ---- two-column layout ----
// Rows are short (≈15-25 cells), so one column left most of the pane empty.
// Whenever both halves' content fits in half the pane's width, the sections are
// dealt into a left and a right column, cut at whichever point in SECTION_ORDER
// makes the two columns closest in height. Each column gets the full row budget
// and runs sectionize on its own, so a split pane shows up to twice as many PRs.
// The decision is made per frame from the real rows, not from a fixed width: a
// fixed 70-column threshold kept a 55-wide pane (room for two) in one column.
//
// The right column starts at an ABSOLUTE cursor column (CSI n G) rather than
// padding the left text with spaces: emoji widths are not agreed between
// terminals (🗣️ is a 1-wide base plus VS16), and space padding would misalign
// the right column by one cell for every row that contains one.

// Terminal cells a rendered row takes. Errs WIDE, which is the safe direction: an
// overestimate only keeps a frame in one column, an underestimate would let a left
// row run under the right column.
function visibleWidth(s: string): number {
  const plain = s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f || cp === 0x200d) continue; // VS16, ZWJ
    w += cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf) ? 2 : 1;
  }
  return w;
}

function columnHeight(secs: Section[], height: Height): number {
  // Rules between sections, plus a footer rule when a column holds one section.
  return secs.reduce((n, s) => n + rowsOf(s.clusters, height), 0) + Math.max(secs.length - 1, 1);
}

function splitColumns(clusters: PRCluster[], maxRows: number, hLeft: Height, hRight: Height): Section[][] {
  const present = SECTION_ORDER.filter((name) => clusters.some((c) => sectionOf(c) === name));
  const full = sectionize(clusters, Number.MAX_SAFE_INTEGER);
  let best = 1;
  let bestHeight = Infinity;
  for (let k = 1; k < present.length; k++) {
    const h = Math.max(
      columnHeight(full.filter((s) => present.indexOf(s.name) < k), hLeft),
      columnHeight(full.filter((s) => present.indexOf(s.name) >= k), hRight),
    );
    if (h < bestHeight) [best, bestHeight] = [k, h];
  }
  const sides = [present.slice(0, best), present.slice(best)];
  return sides.map((names, side) => {
    const own = clusters.filter((c) => names.includes(sectionOf(c)));
    // A one-section column spends a row on its footer label.
    return sectionize(own, names.length === 1 ? Math.max(maxRows - 1, 1) : maxRows, side === 0 ? hLeft : hRight);
  });
}

// A column's lines. A column with ONE section has no rule between sections to
// name it, so it gets a footer rule instead: "── ↑ other ──".
function columnLines(secs: Section[], width: number): string[] {
  const out: string[] = [];
  secs.forEach((sec, i) => {
    if (i > 0) out.push(sectionRule(secs[i - 1].name, sec.name, Math.min(width, 40)));
    out.push(...sec.clusters.flatMap((c) => clusterLines(c, width)));
  });
  if (secs.length === 1) out.push(ruleWith(` ↑ ${secs[0].name} `, Math.min(width, 40)));
  return out;
}

function packClusters(clusters: PRCluster[], maxRows: number): string[] {
  return keptClusters(clusters, maxRows).map(clusterText);
}

// What is on screen right now, one PR url per line, for `termdash open-prs`
// (prefix + O) to hand to the browser.
//
// Written on every paint rather than resolved when the key is pressed, for the
// same reason the Herdr popup's link list is: the pane already knows, and a
// keypress that has to go and ask GitHub first does not feel like a keypress.
// The PR url, not the badge's url — the badge deep-links to one comment, and
// "open the PR" means the PR.
const PR_LIST_PATH = path.join(os.homedir(), ".cache", "termdash", "notiql-prs.txt");

// The click target for the ⧉ below. An APP, not the script, because an OSC-8
// hyperlink carries a URI and LaunchServices will launch an app but only ever
// *open* a .sh in an editor — the same constraint build-ssh-app.sh and the
// Activity Monitor cells in local-status.ts work around. Built by
// ./build-open-prs-app.sh; if it is missing the ⧉ simply does not draw.
const OPEN_PRS_APP = path.join(os.homedir(), "Applications", "Open PRs.app");
// One per column in the two-column layout, so the team column can be opened on
// its own. Same shim, run as `termdash open-prs left|right`; each reads its own
// list file. The combined link above stays for the one-column fallback.
type Side = "left" | "right";
const sideApp = (side: Side) => path.join(os.homedir(), "Applications", `Open PRs (${side}).app`);
const sideListPath = (side: Side) => path.join(os.homedir(), ".cache", "termdash", `notiql-prs-${side}.txt`);

function fileUrl(p: string): string {
  return "file://" + p.split("/").map(encodeURIComponent).join("/");
}

function prCount(clusters: PRCluster[]): number {
  // Counted in PRs, not rows: a collapsed 👔 row opens every PR it stands for.
  return clusters.reduce((n, c) => n + (c.members?.length ?? 1), 0);
}

function writeListFile(file: string, clusters: PRCluster[]): void {
  const body = clusters
    .flatMap((c) => c.members ?? [c])
    .map((c) => `https://github.com/${c.repo}/pull/${c.prNumber}`)
    .join("\n");
  // Truncating to empty matters: an empty pane must clear the list, or O would
  // reopen whatever was on screen the last time there was anything.
  fs.writeFileSync(file, body ? `${body}\n` : "");
}

// `sides` is null in the one-column layout, which empties both side lists so a
// stale column link (there shouldn't be one on screen) opens nothing.
function writePrList(clusters: PRCluster[], sides: Record<Side, PRCluster[]> | null): void {
  try {
    fs.mkdirSync(path.dirname(PR_LIST_PATH), { recursive: true });
    writeListFile(PR_LIST_PATH, clusters);
    for (const side of ["left", "right"] as Side[]) writeListFile(sideListPath(side), sides?.[side] ?? []);
  } catch {
    /* the pane's job is the badges; a failed write costs the shortcut, not the frame */
  }
}

function render(badges: Badge[], err: Error | null, fetchErrors: string[] = []): void {
  process.stdout.write("\x1b[3J\x1b[2J\x1b[H"); // clear scrollback + screen + home — NOT \x1Bc (full reset), which can
  // break UTF-8/emoji rendering inside tmux by resetting character-set mode

  if (err) {
    console.log(`⚠️  ${err.message}`);
    return;
  }

  const rows = process.stdout.rows || 3;
  const badgeRows = Math.max(rows - 1, 1); // one row kept in reserve for an error line, if any

  // IMPORTANT: badges must be printed FIRST, immediately after the clear.
  // Confirmed empirically that anything printed before them (even a plain
  // text header) breaks emoji rendering across every pane, not just tight
  // ones — likely tmux not fully resetting OSC8 hyperlink cell-state
  // between frames when content shifts position. Don't reorder this again
  // without re-testing carefully.
  let onScreen: PRCluster[] = [];
  let sides: Record<Side, PRCluster[]> | null = null;
  let sideNames: Record<Side, string> = { left: "", right: "" };
  let rightStart = 0;
  if (badges.length === 0) {
    console.log(`${DIM}no pending replies${RESET}`);
  } else {
    const clusters = collapseLeadReviews(groupByPR(badges));
    const cols = process.stdout.columns || 40;
    // Columns split at mid-pane with a two-cell gutter; the last terminal column
    // stays empty so no line can wrap. A row too wide for its column wraps its
    // badges onto the next line (clusterLines), and the row budget counts those
    // lines. Falls back to one column only if something unbreakable — a single
    // badge, a collapsed 👔 row, a separator label — still doesn't fit.
    const start = Math.floor(cols / 2);
    const lw = start - 2;
    const rw = cols - 1 - start;
    const hLeft: Height = (c) => clusterLines(c, lw).length;
    const hRight: Height = (c) => clusterLines(c, rw).length;
    const [left, right] =
      new Set(clusters.map(sectionOf)).size > 1 ? splitColumns(clusters, badgeRows, hLeft, hRight) : [[], []];
    const l = columnLines(left, lw);
    const r = columnLines(right, rw);
    const fits =
      right.length > 0 && l.every((x) => visibleWidth(x) <= lw) && r.every((x) => visibleWidth(x) <= rw);
    if (fits) {
      for (let i = 0; i < Math.max(l.length, r.length); i++) {
        console.log(`${l[i] ?? ""}${r[i] ? `\x1b[${start + 1}G${r[i]}` : ""}`);
      }
      onScreen = [...left, ...right].flatMap((sec) => sec.clusters);
      sides = {
        left: left.flatMap((sec) => sec.clusters),
        right: right.flatMap((sec) => sec.clusters),
      };
      sideNames = { left: left.map((s) => s.name).join("+"), right: right.map((s) => s.name).join("+") };
      rightStart = start;
    } else {
      const sections = sectionize(clusters, badgeRows);
      sections.forEach((sec, i) => {
        if (i > 0) console.log(sectionRule(sections[i - 1].name, sec.name));
        for (const l of sec.clusters.map(clusterText)) console.log(l);
      });
      onScreen = sections.flatMap((sec) => sec.clusters);
    }
  }
  const onScreenPrs = prCount(onScreen);

  if (fetchErrors.length > 0) {
    console.log(`${RED}⚠ ${fetchErrors.length} fetch error(s) — try --debug${RESET}`);
  } else if (sides) {
    // Two columns: one link at the foot of each, opening only that column — e.g.
    // just the team section. Same reserved row and same two-PR minimum as the
    // combined link below; the right one is placed with CSI n G like its rows.
    const cell = (side: Side) => {
      const n = prCount(sides![side]);
      if (n < 2 || !fs.existsSync(sideApp(side))) return "";
      return `${LINK_BLUE}${link(`⧉ open ${sideNames[side]} ${n}`, fileUrl(sideApp(side)))}${RESET}`;
    };
    const l = cell("left");
    const r = cell("right");
    if (l || r) console.log(`${l}${r ? `\x1b[${rightStart + 1}G${r}` : ""}`);
  } else if (onScreenPrs > 1 && fs.existsSync(OPEN_PRS_APP)) {
    // Rides in the row render() already holds back for an error line, so it costs
    // no badge row — and it yields that row the moment there IS an error, because
    // a convenience must not push a failure off the pane.
    //
    // Only from two PRs up: at one, the badge beside it already does this.
    console.log(
      `${LINK_BLUE}${link(`⧉ open all ${onScreenPrs}`, fileUrl(OPEN_PRS_APP))}${RESET}`,
    );
  }

  // After the paint, never before: see the badges-print-first note above.
  writePrList(onScreen, sides);
}

// The last successful frame's data, so a finished effort rating can repaint
// without waiting for the next poll or re-fetching anything.
let lastFrame: { badges: Badge[]; errors: string[] } | null = null;

async function loop(): Promise<void> {
  let team: { repo: string; prNumber: number }[] = [];
  try {
    const { badges, errors } = await fetchBadges();
    lastFrame = { badges, errors };
    render(badges, null, errors);
    team = teamPRs(badges);
  } catch (err) {
    lastFrame = null;
    render([], err as Error);
  }
  // Same deal as the summaries below: after the paint, never awaited. When it
  // stores new ratings it repaints from the latest frame (which may be newer than
  // the one that started it), so the tags and the sort land within seconds.
  void rateEfforts(team, ghGraphQL).then((changed) => {
    if (changed && lastFrame) render(lastFrame.badges, null, lastFrame.errors);
  });
  // AFTER the paint and deliberately not awaited — see warmCommentSummaries.
  // The pane's job is the badges; filling the summary cache for the brief is a
  // side effect that must never delay a frame or the next poll.
  void warmCommentSummaries();
  setTimeout(loop, POLL_SECONDS * 1000);
}

// ---- debug mode ----
// Usage: npx tsx pr-comment-bubbles.ts --debug owner/repo#123
// Dumps every review thread on that PR with full comment detail and walks
// through exactly why each thread would be shown or hidden.

async function debugPR(spec: string): Promise<void> {
  const match = spec.match(/^([^/]+)\/([^/#]+)[#/](\d+)$/);
  if (!match) {
    console.error("Usage: --debug owner/repo#123  (or owner/repo/123)");
    process.exit(1);
  }
  const [, owner, repo, numberStr] = match;
  const number = parseInt(numberStr, 10);

  const me = await getUsername();
  const meLower = me.toLowerCase();
  const mentionTag = `@${meLower}`;

  let prAuthorLower: string | undefined;
  try {
    const prInfo = await gh<{ user: { login: string } | null }>(`/repos/${owner}/${repo}/pulls/${number}`);
    prAuthorLower = prInfo.user?.login?.toLowerCase();
  } catch {
    // non-fatal — verdicts just won't be able to name the author-specific case
  }

  // Calling ghGraphQL directly (not fetchReviewThreads) so we can give
  // friendlier messages for "repo not found" vs "PR not found" vs a real
  // API error, and so we can surface rate-limit info either way.
  let threads: ReviewThread[];
  let rateLimit: RateLimitInfo | null = null;
  try {
    const result = await ghGraphQL<PRThreadsData>(REVIEW_THREADS_QUERY, { owner, repo, number });
    rateLimit = result.rateLimit;
    if (!result.repository) {
      console.error(`\nNo repository found for ${owner}/${repo}. Check the token has access to it.`);
      return;
    }
    if (!result.repository.pullRequest) {
      console.error(`\nNo PR #${number} found in ${owner}/${repo}. Check the PR number.`);
      return;
    }
    threads = result.repository.pullRequest.reviewThreads.nodes;
  } catch (err) {
    console.error(`\nGraphQL request failed: ${(err as Error).message}`);
    console.error("This is almost certainly why real polling shows 0 threads too — fix this first.\n");
    return;
  }
  console.log(`\nDebugging ${owner}/${repo}#${number} — you are logged in as: ${me}`);
  if (rateLimit) {
    const resetTime = new Date(rateLimit.resetAt).toLocaleTimeString();
    const color = rateLimitColor(rateLimit.remaining, rateLimit.limit);
    console.log(
      `${color}GraphQL: ${rateLimit.remaining}/${rateLimit.limit} pts (this query cost ${rateLimit.cost}, resets ${resetTime})${RESET}`
    );
  }
  console.log(`Found ${threads.length} review thread(s)\n`);

  threads.forEach((thread, i) => {
    console.log(`━━━ Thread ${i + 1} ━━━`);
    console.log(`isResolved: ${thread.isResolved}   isOutdated: ${thread.isOutdated}`);

    const comments = [...thread.comments.nodes].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    comments.forEach((c, j) => {
      const author = c.author?.login ?? "(deleted user / null author)";
      const reactorLogins = c.reactions.nodes.map((r) => r.user?.login).filter(Boolean);
      const bodySnippet = c.body.replace(/\s+/g, " ").slice(0, 90);
      console.log(`  [${j}] author: ${author}   at: ${c.createdAt}`);
      console.log(`      body: "${bodySnippet}${c.body.length > 90 ? "…" : ""}"`);
      console.log(`      url: ${c.url}`);
      console.log(`      👍 reactions: ${reactorLogins.length > 0 ? reactorLogins.join(", ") : "(none)"}`);
    });

    const latest = comments[comments.length - 1];
    const latestAuthor = latest?.author?.login?.toLowerCase();
    let verdict: string;

    if (!latest) {
      verdict = "no comments in thread — excluded";
    } else if (!latestAuthor) {
      verdict = "latest comment has no resolvable author (null/deleted) — excluded";
    } else if (latestAuthor === meLower) {
      const closedByStatus = thread.isResolved || thread.isOutdated;
      const authorReacted =
        prAuthorLower != null &&
        latest.reactions.nodes.some((r) => r.user?.login?.toLowerCase() === prAuthorLower);
      let participatingNote: string;
      if (closedByStatus) {
        participatingNote = "on a PR you're participating in: hidden (resolved/outdated)";
      } else if (authorReacted) {
        participatingNote =
          `on a PR you're participating in: hidden — PR author (${prAuthorLower}) 👍'd your comment (soft-resolved)`;
      } else if (!prAuthorLower) {
        participatingNote = "on a PR you're participating in: shows 🗣️ (couldn't determine PR author to check for a soft-resolving 👍)";
      } else {
        participatingNote = "on a PR you're participating in: shows 🗣️ (waiting on a reply)";
      }
      verdict = `latest comment is YOURS — on your own PR this hides the badge; ${participatingNote}`;
    } else {
      const iReacted = latest.reactions.nodes.some((r) => r.user?.login?.toLowerCase() === meLower);
      if (iReacted) {
        verdict = "you reacted 👍 to the latest comment — excluded (treated as acknowledged)";
      } else if (thread.isResolved || thread.isOutdated) {
        const mentionsMe = latest.body.toLowerCase().includes(mentionTag);
        const reason = thread.isResolved && thread.isOutdated ? "resolved+outdated" : thread.isResolved ? "resolved" : "outdated";
        verdict = mentionsMe
          ? `thread is ${reason} BUT latest comment mentions you — included`
          : `thread is ${reason}, no mention of you — excluded`;
      } else {
        verdict = `not resolved, someone else has the last word — included (${
          isBot(latestAuthor) ? "🐛 bot" : "💬/👥 human"
        })`;
      }
    }

    console.log(`  VERDICT: ${verdict}\n`);
  });
}

// ---- --limits mode: a quick, near-zero-cost budget check, no PR data pulled ----

const RATE_LIMIT_ONLY_QUERY = `
  query {
    rateLimit {
      cost
      remaining
      limit
      resetAt
    }
  }
`;

async function checkLimits(): Promise<void> {
  try {
    const result = await ghGraphQL<{ rateLimit: RateLimitInfo }>(RATE_LIMIT_ONLY_QUERY, {});
    const { remaining, limit, cost, resetAt } = result.rateLimit;
    const color = rateLimitColor(remaining, limit);
    const resetTime = new Date(resetAt).toLocaleTimeString();
    console.log(
      `${color}GraphQL: ${remaining}/${limit} pts (this check cost ${cost}, resets ${resetTime})${RESET}`
    );
  } catch (err) {
    console.error(`Failed to check rate limit: ${(err as Error).message}`);
  }
}

// ---- entry point ----

const debugIndex = process.argv.indexOf("--debug");

if (debugIndex !== -1) {
  const spec = process.argv[debugIndex + 1];
  if (!GITHUB_TOKEN) {
    console.error("Set GITHUB_TOKEN env var first.");
    process.exit(1);
  }
  if (!spec) {
    console.error("Usage: npx tsx pr-comment-bubbles.ts --debug owner/repo#123");
    process.exit(1);
  }
  debugPR(spec);
} else if (process.argv.includes("--limits")) {
  if (!GITHUB_TOKEN) {
    console.error("Set GITHUB_TOKEN env var first.");
    process.exit(1);
  }
  checkLimits();
} else if (process.argv.includes("--mock")) {
  const now = new Date();
  const mkIso = (offsetMin: number) => new Date(now.getTime() - offsetMin * 60000).toISOString();

  myLoginLower = "me";
  const mockBadges: Badge[] = [
    { icon: "💬", url: "https://github.com/Popmenu/popmenu/pull/1", createdAt: mkIso(50), repo: "Popmenu/popmenu", prNumber: 1, author: "me" }, // 50m
    { icon: "🗣️", url: "https://github.com/Popmenu/popmenu/pull/2", createdAt: mkIso(180), repo: "Popmenu/popmenu", prNumber: 2 }, // 3h
    { icon: "👀", url: "https://github.com/Popmenu/popmenu/pull/2", createdAt: mkIso(240), repo: "Popmenu/popmenu", prNumber: 2 }, // 4h
    { icon: "👔", url: "https://github.com/Popmenu/popmenu/pull/8", createdAt: mkIso(300), repo: "Popmenu/popmenu", prNumber: 8, author: "solo-dev" }, // lead-reviewers team request, 5h
    ...[9, 10, 11, 12].map((n) => ({ icon: "👔", url: `https://github.com/Popmenu/popmenu/pull/${n}`, createdAt: mkIso(60 + n), repo: "Popmenu/popmenu", prNumber: n, author: "burst-dev" })), // one dev's stack — collapses to one row
    { icon: "👥", url: "https://github.com/Popmenu/popmenu/pull/3", createdAt: mkIso(5760), repo: "Popmenu/popmenu", prNumber: 3, author: "joseneto" }, // 4d, teammate
    { icon: "📣", url: "https://github.com/Popmenu/popmenu/pull/7#issuecomment-1", createdAt: mkIso(15), repo: "Popmenu/popmenu", prNumber: 7 }, // @-mention, 15m
    { icon: "🤝", url: "https://github.com/Popmenu/popmenu/pull/35188", createdAt: mkIso(45), repo: "Popmenu/popmenu", prNumber: 35188, author: "tsabz" }, // team review queue (Shortcut), 45m
    { icon: "📣", url: "https://github.com/Popmenu/popmenu/pull/3#issuecomment-2", createdAt: mkIso(120), repo: "Popmenu/popmenu", prNumber: 3 }, // @-mention sharing a PR with 👥, 2h
    { icon: "🐛", url: "https://github.com/Popmenu/popmenu/pull/4", createdAt: mkIso(20160), repo: "Popmenu/popmenu", prNumber: 4, author: "me" }, // 2w
    { icon: "👷", url: "https://github.com/Popmenu/popmenu/pull/5", createdAt: mkIso(90), repo: "Popmenu/popmenu", prNumber: 5, author: "me" }, // QA deployed, 1.5h
    { icon: "✅", url: "https://github.com/Popmenu/popmenu/pull/6", createdAt: mkIso(30), repo: "Popmenu/popmenu", prNumber: 6, author: "me" }, // QA passed, 30m
  ];
  render(mockBadges, null);
} else {
  if (!GITHUB_TOKEN) {
    console.error("Set GITHUB_TOKEN env var first.");
    process.exit(1);
  }
  process.stdout.write(HIDE_CURSOR);
  process.on("exit", () => process.stdout.write(SHOW_CURSOR));
  process.on("SIGINT", () => {
    process.stdout.write(SHOW_CURSOR);
    process.exit(0);
  });
  loop();
}
