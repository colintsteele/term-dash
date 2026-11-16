/**
 * Review-effort ratings (low / medium / high) for teammates' PRs.
 *
 * git-notiql.ts uses this to sort its "team" section so the quick reviews come
 * first. A rating comes from a quick glance at the PR: its title, a trimmed body,
 * the size of the change, and the list of files with per-file line counts. It
 * never reads the diff. Headless Claude (Haiku) rates every unrated PR in one
 * batched call.
 *
 * Each PR is rated ONCE, and the rating is kept on disk for EFFORT_TTL_MS
 * (30 days) after it was made. It is deliberately not re-rated when the PR
 * changes: the point is to look once. An expired entry is pruned, and the PR
 * gets rated again if it still shows up in the pane.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

export type Effort = "low" | "medium" | "high";
export const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2 };

const CACHE_PATH = path.join(os.homedir(), ".local/state/termdash/pr-effort.json");
const EFFORT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RATE_TIMEOUT_MS = 120_000;
// After a failed rating call (timeout, claude missing, unparseable output), wait
// this long before asking again. Without it, the 60s poll would re-ask every minute.
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
const MAX_FILES_LISTED = 60;
const BODY_CHARS = 1500;

type Cache = Record<string, { effort: Effort; ratedAt: string }>; // key: "owner/repo#123"

let cache: Cache | null = null;

function isLive(entry: { ratedAt: string }, now = Date.now()): boolean {
  return now - new Date(entry.ratedAt).getTime() < EFFORT_TTL_MS;
}

function load(): Cache {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as Cache;
  } catch {
    cache = {};
  }
  return cache;
}

function save(): void {
  const c = load();
  const now = Date.now();
  for (const [k, v] of Object.entries(c)) if (!isLive(v, now)) delete c[k];
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2));
  } catch {
    /* losing the cache costs a re-rating, not correctness */
  }
}

export function prKey(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

/** The cached rating, or undefined if the PR is unrated or its rating has expired. */
export function effortOf(repo: string, prNumber: number): Effort | undefined {
  const hit = load()[prKey(repo, prNumber)];
  return hit && isLive(hit) ? hit.effort : undefined;
}

// ---- rating ----

type GraphQL = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;

interface PRGlance {
  title: string;
  body: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { nodes: { path: string; additions: number; deletions: number }[] } | null;
}

let rating = false;
let lastFailureAt = 0;

/**
 * Rates every PR in `prs` that has no live rating. Safe to call on every poll
 * and never awaited by the render path: it returns at once if a rating call is
 * already running, or if the last one failed within FAILURE_BACKOFF_MS.
 * Resolves true when it stored at least one new rating, so the caller knows to repaint.
 */
export async function rateEfforts(prs: { repo: string; prNumber: number }[], gql: GraphQL): Promise<boolean> {
  if (rating || Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) return false;
  const seen = new Set<string>();
  const todo = prs.filter((p) => {
    const k = prKey(p.repo, p.prNumber);
    if (seen.has(k) || effortOf(p.repo, p.prNumber)) return false;
    seen.add(k);
    return true;
  });
  if (!todo.length) return false;

  rating = true;
  try {
    // One aliased query for the whole batch.
    const query = `query {
      ${todo
        .map((p, i) => {
          const [owner, name] = p.repo.split("/");
          return `p${i}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${p.prNumber}) {
            title body additions deletions changedFiles
            files(first: ${MAX_FILES_LISTED}) { nodes { path additions deletions } }
          } }`;
        })
        .join("\n")}
    }`;
    const data = await gql<Record<string, { pullRequest: PRGlance | null } | null>>(query, {});

    const glances = todo.flatMap((p, i) => {
      const pr = data[`p${i}`]?.pullRequest;
      if (!pr) return [];
      const files = pr.files?.nodes ?? [];
      return [
        {
          id: prKey(p.repo, p.prNumber),
          title: pr.title,
          body: (pr.body ?? "").slice(0, BODY_CHARS),
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changedFiles,
          files: files.map((f) => `${f.path} +${f.additions} -${f.deletions}`),
          filesTruncated: pr.changedFiles > files.length,
        },
      ];
    });
    if (!glances.length) return false;

    const prompt =
      "You are triaging pull requests for a code reviewer on a large Rails + React " +
      "codebase. For each PR below, take a quick glance (title, description, size, " +
      "file list) and rate the effort a careful review will take:\n" +
      '- "low": small or mechanical — copy changes, config, a focused bug fix, tests only, ' +
      "renames, dependency bumps.\n" +
      '- "medium": a normal feature or fix touching a handful of files with real logic to follow.\n' +
      '- "high": large or risky — schema migrations, data backfills, auth/billing/permissions, ' +
      "concurrency, cross-cutting refactors, or many files with substantive logic.\n" +
      "Weigh risk as well as size: a 20-line migration can be high, a 900-line " +
      "generated file can be low.\n\n" +
      'Return ONLY a JSON array of {"id": string, "effort": "low"|"medium"|"high"}, ' +
      "one entry per PR, with no prose and no code fence.\n\n" +
      JSON.stringify(glances, null, 2);

    const { stdout } = await execFileP("claude", ["-p", "--model", "haiku", prompt], {
      timeout: RATE_TIMEOUT_MS,
      maxBuffer: 8 << 20,
    });
    const m = stdout.match(/\[[\s\S]*\]/);
    const parsed = m ? (JSON.parse(m[0]) as { id: string; effort: string }[]) : [];

    const c = load();
    const now = new Date().toISOString();
    let wrote = 0;
    for (const r of parsed) {
      if (r.effort in EFFORT_RANK && glances.some((g) => g.id === r.id)) {
        c[r.id] = { effort: r.effort as Effort, ratedAt: now };
        wrote++;
      }
    }
    if (!wrote) throw new Error("no usable ratings");
    save();
    return true;
  } catch {
    lastFailureAt = Date.now();
    return false;
  } finally {
    rating = false;
  }
}

// ---- CLI: `npx tsx pr-effort.ts` lists the cache ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const c = load();
  const now = Date.now();
  for (const [k, v] of Object.entries(c).sort((a, b) => EFFORT_RANK[a[1].effort] - EFFORT_RANK[b[1].effort])) {
    const daysLeft = Math.ceil((EFFORT_TTL_MS - (now - new Date(v.ratedAt).getTime())) / 86_400_000);
    console.log(`${v.effort.padEnd(6)} ${k}  ${isLive(v, now) ? `${daysLeft}d left` : "expired"}`);
  }
}
