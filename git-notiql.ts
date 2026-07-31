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
 *   🤝  a PR attached to a ticket sitting in your team's "Ready for Review" column
 *       that still needs review (not yours, not draft/closed/merged, and not
 *       already approved).
 *   Shortcut-driven because the GitHub framings are unusable at this repo's scale:
 *   153 open PRs, 144 not yours, 65 even after non-draft/untouched/this-week
 *   filtering. "Tickets in MY TEAM's Ready for Review column" is 3, and 1 after
 *   filtering — the same question with three orders of magnitude less noise.
 *   Needs SHORTCUT_RO_TOKEN; without it the category is skipped and nothing else
 *   changes. Team + column are configured BY NAME (SC_TEAM_NAME /
 *   SC_REVIEW_STATE_NAME) and resolved to ids at runtime.
 *   Clears itself when the story leaves Ready for Review.
 *
 * PENDING REVIEW REQUESTS — PRs where you're a requested reviewer:
 *   👀  no action from you yet
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
const SC_REVIEW_STATE_NAME = "Ready for Review";

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
}

interface SearchItem {
  number: number;
  repository_url: string;
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

async function fetchReviewRequestBadges(meLower: string): Promise<{ badges: Badge[]; errors: string[] }> {
  const items = await searchPRs(`is:pr is:open review-requested:${meLower}`);
  const badges: Badge[] = [];
  const errors: string[] = [];

  for (const item of items) {
    const [owner, repo] = repoOwnerFromUrl(item.repository_url);
    const cacheKey = `reviewrequest:${owner}/${repo}#${item.number}`;
    const cached = prBadgeCache.get(cacheKey);

    if (cached && cached.updatedAt === item.updated_at) {
      badges.push(...cached.badges);
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
            icon: "👀",
            url: `https://github.com/${owner}/${repo}/pull/${item.number}/files`,
            createdAt: item.updated_at,
            repo: `${owner}/${repo}`,
            prNumber: item.number,
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
//   review_status — Shortcut tracks GitHub's review state on the attached PR, so
//                 "approved" ones drop out. Without it, 3 stories would badge 3 PRs,
//                 two of which had already been reviewed.
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
let scIds: { groupId: string; stateId: number } | null = null;

async function resolveScIds(): Promise<{ groupId: string; stateId: number } | null> {
  if (scIds) return scIds;
  const groups = await shortcut<{ id: string; name: string; archived: boolean }[]>("/groups");
  const group = groups.find((g) => !g.archived && g.name === SC_TEAM_NAME);
  if (!group) return null;

  const workflows = await shortcut<{ states: { id: number; name: string }[] }[]>("/workflows");
  for (const w of workflows) {
    const state = w.states.find((s) => s.name.trim() === SC_REVIEW_STATE_NAME);
    if (state) {
      scIds = { groupId: group.id, stateId: state.id };
      return scIds;
    }
  }
  return null;
}

// Story id → the badges it produced, keyed on the story's updated_at, so an unchanged
// story skips its detail fetch entirely (same trick as prBadgeCache).
const scStoryCache = new Map<number, { updatedAt: string; badges: Badge[] }>();

async function fetchTeamReviewBadges(): Promise<{ badges: Badge[]; errors: string[] }> {
  const badges: Badge[] = [];
  const errors: string[] = [];
  if (!SHORTCUT_TOKEN) return { badges, errors };

  let ids: { groupId: string; stateId: number } | null;
  try {
    ids = await resolveScIds();
  } catch (err) {
    return { badges, errors: [`shortcut ids: ${(err as Error).message}`] };
  }
  if (!ids) {
    return { badges, errors: [`shortcut: no team "${SC_TEAM_NAME}" / state "${SC_REVIEW_STATE_NAME}"`] };
  }

  let stories: ScStory[];
  try {
    stories = await shortcut<ScStory[]>("/stories/search", {
      group_id: ids.groupId,
      workflow_state_id: ids.stateId,
    });
  } catch (err) {
    return { badges, errors: [`shortcut search: ${(err as Error).message}`] };
  }

  // The one filter that isn't obvious — see the comment above.
  const live = stories.filter((s) => !s.archived);

  const seenPrs = new Set<number>(); // one story's PR can be attached to another's
  for (const story of live) {
    const cached = scStoryCache.get(story.id);
    if (cached && cached.updatedAt === story.updated_at) {
      for (const b of cached.badges) {
        if (!seenPrs.has(b.prNumber)) {
          seenPrs.add(b.prNumber);
          badges.push(b);
        }
      }
      continue;
    }

    let detail: { pull_requests?: ScPullRequest[] };
    try {
      detail = await shortcut(`/stories/${story.id}`);
    } catch (err) {
      errors.push(`sc-${story.id}: ${(err as Error).message}`);
      continue;
    }

    const storyBadges: Badge[] = [];
    for (const pr of detail.pull_requests ?? []) {
      if (pr.merged || pr.closed || pr.draft) continue;
      if (pr.review_status === "approved") continue;
      if ((pr.branch_name ?? "").startsWith(MY_BRANCH_PREFIX)) continue;
      const repoMatch = pr.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//);
      storyBadges.push({
        icon: TEAM_REVIEW_ICON,
        url: pr.url,
        createdAt: pr.updated_at ?? story.updated_at,
        repo: repoMatch ? repoMatch[1] : "",
        prNumber: pr.number,
      });
    }

    scStoryCache.set(story.id, { updatedAt: story.updated_at, badges: storyBadges });
    for (const b of storyBadges) {
      if (!seenPrs.has(b.prNumber)) {
        seenPrs.add(b.prNumber);
        badges.push(b);
      }
    }
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

  const all = [
    ...own.badges,
    ...participating.badges,
    ...reviewRequests.badges,
    ...mentions.badges,
    ...teamReview.badges,
    ...qa.badges,
  ];
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
    ],
  };
}

interface PRCluster {
  key: string;
  repo: string;
  prNumber: number;
  badges: Badge[];
  latestCreatedAt: string;
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

function clusterText(cluster: PRCluster): string {
  const prUrl = `https://github.com/${cluster.repo}/pull/${cluster.prNumber}`;
  const label = webLink(`#${cluster.prNumber}`, prUrl);
  const badgeParts = cluster.badges
    .map((b) => `${b.icon} ${webLink(formatAge(b.createdAt), b.url)}`)
    .join(" ");
  return `${label}  ${badgeParts}`;
}

// one line per PR, always — keep the newest N if there isn't enough
// vertical room for all of them
function packClusters(clusters: PRCluster[], maxRows: number): string[] {
  const kept = clusters.length > maxRows ? clusters.slice(clusters.length - maxRows) : clusters;
  return kept.map(clusterText);
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
  if (badges.length === 0) {
    console.log(`${DIM}no pending replies${RESET}`);
  } else {
    const clusters = groupByPR(badges);
    const lines = packClusters(clusters, badgeRows);
    for (const l of lines) console.log(l);
  }

  if (fetchErrors.length > 0) {
    console.log(`${RED}⚠ ${fetchErrors.length} fetch error(s) — try --debug${RESET}`);
  }
}

async function loop(): Promise<void> {
  try {
    const { badges, errors } = await fetchBadges();
    render(badges, null, errors);
  } catch (err) {
    render([], err as Error);
  }
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

  const mockBadges: Badge[] = [
    { icon: "💬", url: "https://github.com/Popmenu/popmenu/pull/1", createdAt: mkIso(50), repo: "Popmenu/popmenu", prNumber: 1 }, // 50m
    { icon: "🗣️", url: "https://github.com/Popmenu/popmenu/pull/2", createdAt: mkIso(180), repo: "Popmenu/popmenu", prNumber: 2 }, // 3h
    { icon: "👀", url: "https://github.com/Popmenu/popmenu/pull/2", createdAt: mkIso(240), repo: "Popmenu/popmenu", prNumber: 2 }, // 4h
    { icon: "👥", url: "https://github.com/Popmenu/popmenu/pull/3", createdAt: mkIso(5760), repo: "Popmenu/popmenu", prNumber: 3 }, // 4d
    { icon: "📣", url: "https://github.com/Popmenu/popmenu/pull/7#issuecomment-1", createdAt: mkIso(15), repo: "Popmenu/popmenu", prNumber: 7 }, // @-mention, 15m
    { icon: "🤝", url: "https://github.com/Popmenu/popmenu/pull/35188", createdAt: mkIso(45), repo: "Popmenu/popmenu", prNumber: 35188 }, // team review queue (Shortcut), 45m
    { icon: "📣", url: "https://github.com/Popmenu/popmenu/pull/3#issuecomment-2", createdAt: mkIso(120), repo: "Popmenu/popmenu", prNumber: 3 }, // @-mention sharing a PR with 👥, 2h
    { icon: "🐛", url: "https://github.com/Popmenu/popmenu/pull/4", createdAt: mkIso(20160), repo: "Popmenu/popmenu", prNumber: 4 }, // 2w
    { icon: "👷", url: "https://github.com/Popmenu/popmenu/pull/5", createdAt: mkIso(90), repo: "Popmenu/popmenu", prNumber: 5 }, // QA deployed, 1.5h
    { icon: "✅", url: "https://github.com/Popmenu/popmenu/pull/6", createdAt: mkIso(30), repo: "Popmenu/popmenu", prNumber: 6 }, // QA passed, 30m
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
