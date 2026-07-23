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
 * PENDING REVIEW REQUESTS — PRs where you're a requested reviewer:
 *   👀  no action from you yet
 *   Clears once you've either submitted a formal review (approve, request
 *   changes, or a review-comment) OR left a plain comment — either counts
 *   as "handled" even though GitHub itself only auto-clears the request on
 *   a formal review, not a plain comment.
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
 * PR's updated_at. Since only the two reaction-dependent rules above are
 * affected (both in the participating category), only PRs currently
 * holding a live participating badge get periodically force-rechecked —
 * not your whole PR list. Own-PR (💬) badges never depend on reactions and
 * are never force-refreshed.
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

const FORCE_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
let lastForceRefreshAt = 0;

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
  mentionTag: string
): Promise<{ badges: Badge[]; errors: string[] }> {
  const items = await searchPRs(`is:pr is:open commenter:${meLower} -author:${meLower}`);
  const badges: Badge[] = [];
  const errors: string[] = [];
  const dueForForceRefresh = shouldForceRefresh();

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

async function fetchBadges(): Promise<{ badges: Badge[]; errors: string[] }> {
  const me = await getUsername();
  const meLower = me.toLowerCase();
  const mentionTag = `@${meLower}`;

  const [own, participating, reviewRequests] = await Promise.all([
    fetchOwnPRBadges(meLower, mentionTag),
    fetchParticipatingBadges(meLower, mentionTag),
    fetchReviewRequestBadges(meLower),
  ]);

  const all = [...own.badges, ...participating.badges, ...reviewRequests.badges];
  all.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return { badges: all, errors: [...own.errors, ...participating.errors, ...reviewRequests.errors] };
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
  const label = link(`#${cluster.prNumber}`, prUrl);
  const badgeParts = cluster.badges
    .map((b) => `${b.icon} ${link(formatAge(b.createdAt), b.url)}`)
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
    { icon: "🐛", url: "https://github.com/Popmenu/popmenu/pull/4", createdAt: mkIso(20160), repo: "Popmenu/popmenu", prNumber: 4 }, // 2w
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
