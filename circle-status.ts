#!/usr/bin/env -S npx tsx
/**
 * Terminal CI status dashboard — colored dot per branch YOU triggered,
 * pulled from CircleCI, filtered down to branches that still have an open
 * GitHub PR (CircleCI's own "pipeline/mine" has no concept of PR state —
 * without this check, a merged/closed PR's branch keeps showing up until
 * its pipeline simply ages out of CircleCI's recent history).
 * Clickable (cmd/ctrl-click) links via OSC 8 hyperlinks — built for iTerm2.
 *
 * SETUP:
 *   1. npm install -D tsx typescript   (or: npm install -g tsx)
 *   2. Get a CircleCI personal API token: CircleCI -> your avatar -> Personal API Tokens
 *      https://app.circleci.com/settings/user/tokens
 *   3. export CIRCLECI_TOKEN="your-token-here"
 *   4. export GITHUB_TOKEN="$(gh auth token)"   # needed for the open-PR check;
 *      without it, this falls back to showing everything CircleCI knows about,
 *      unfiltered, with a warning
 *   5. chmod +x circleci-status.ts
 *   6. Run directly in a tmux pane: ./circleci-status.ts
 */

const CIRCLECI_TOKEN = process.env.CIRCLECI_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PROJECT_SLUGS: string[] = ["gh/Popmenu/popmenu"]; // add more slugs if you work across repos
const REFRESH_SECONDS = 60;

const CIRCLECI_API = "https://circleci.com/api/v2";
const GITHUB_API = "https://api.github.com";

if (!CIRCLECI_TOKEN) {
  console.error("Set CIRCLECI_TOKEN env var first.");
  process.exit(1);
}

// ---- Types for the slice of the CircleCI API we actually use ----

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

interface Pipeline {
  id: string;
  number: number;
  vcs?: { branch?: string };
  // Present when the project uses CircleCI's GitHub App integration
  // (branch isn't under vcs in that case — it's here instead).
  trigger_parameters?: {
    git?: { branch?: string };
    github_app?: { branch?: string };
  };
}

interface PipelineListResponse {
  items: Pipeline[];
}

interface Workflow {
  id: string;
  name: string;
  status: WorkflowStatus;
}

interface WorkflowListResponse {
  items: Workflow[];
}

interface BranchStatus {
  repo: string;
  branch: string;
  status: WorkflowStatus | "unknown";
  url: string;
}

async function cc<T>(path: string): Promise<T> {
  const res = await fetch(`${CIRCLECI_API}${path}`, {
    headers: { "Circle-Token": CIRCLECI_TOKEN as string },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function gh<T>(path: string): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`github ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// Targeted check per branch (cheaper than fetching every open PR and cross
// referencing, since CircleCI has already narrowed things to a handful of
// branches by this point).
async function hasOpenPR(owner: string, repo: string, branch: string): Promise<boolean> {
  try {
    const prs = await gh<{ number: number }[]>(
      `/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`
    );
    return prs.length > 0;
  } catch {
    // fail open — better to show a possibly-stale branch than silently
    // hide a real one because of a transient API error
    return true;
  }
}

// ANSI colors
const RESET = "\x1b[0m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const GRAY = "\x1b[90m";

function dotFor(status: BranchStatus["status"]): string {
  if (["failed", "failing", "error"].includes(status)) return `${RED}●${RESET}`;
  if (["running", "on_hold"].includes(status)) return `${YELLOW}●${RESET}`;
  if (status === "success") return `${GREEN}●${RESET}`;
  return `${GRAY}●${RESET}`; // canceled, not_run, unauthorized, unknown
}

// worst-status-wins across a pipeline's workflows
function worstStatus(statuses: WorkflowStatus[]): WorkflowStatus | "unknown" {
  const order: WorkflowStatus[] = ["failed", "failing", "error", "running", "on_hold", "success"];
  for (const s of order) if (statuses.includes(s)) return s;
  return statuses[0] ?? "unknown";
}

function link(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

async function fetchStatuses(): Promise<BranchStatus[]> {
  const results: BranchStatus[] = [];

  for (const slug of PROJECT_SLUGS) {
    const mine = await cc<PipelineListResponse>(`/project/${slug}/pipeline/mine`);
    const pipelines = mine.items ?? [];

    // dedupe: keep only the most recent pipeline per branch
    const latestByBranch = new Map<string, Pipeline>();
    for (const p of pipelines) {
      const branch =
        p.vcs?.branch ||
        p.trigger_parameters?.git?.branch ||
        p.trigger_parameters?.github_app?.branch;
      if (!branch) continue;
      const existing = latestByBranch.get(branch);
      if (!existing || p.number > existing.number) {
        latestByBranch.set(branch, p);
      }
    }

    for (const [branch, pipeline] of latestByBranch) {
      const [owner, repo] = slug.replace(/^gh\//, "").split("/");

      if (GITHUB_TOKEN) {
        const open = await hasOpenPR(owner, repo, branch);
        if (!open) continue; // no open PR (closed/merged, or a non-PR branch like master) — skip it
      }

      let workflows: WorkflowListResponse;
      try {
        workflows = await cc<WorkflowListResponse>(`/pipeline/${pipeline.id}/workflow`);
      } catch {
        continue;
      }
      const items = workflows.items ?? [];
      if (items.length === 0) continue;

      const status = worstStatus(items.map((w) => w.status));
      const target = items.find((w) => w.status === status) ?? items[0];

      results.push({
        repo: slug.replace(/^gh\//, ""),
        branch,
        status,
        url: `https://app.circleci.com/pipelines/${slug}/${pipeline.number}/workflows/${target.id}`,
      });
    }
  }

  return results;
}

function render(results: BranchStatus[], err: Error | null): void {
  process.stdout.write("\x1b[3J\x1b[2J\x1b[H"); // clear scrollback + screen + home, not a full reset (\x1Bc) —

  const now = new Date().toLocaleTimeString();
  console.log(`${BOLD}CircleCI Status${RESET}  ${DIM}(updated ${now}, every ${REFRESH_SECONDS}s)${RESET}`);
  if (!GITHUB_TOKEN) {
    console.log(`${YELLOW}⚠ no GITHUB_TOKEN — showing unfiltered, may include closed PRs${RESET}`);
  }
  const sepWidth = process.stdout.columns || 40;
  console.log(DIM + "─".repeat(sepWidth) + RESET);

  if (err) {
    console.log(`${RED}Error fetching status:${RESET} ${err.message}`);
    return;
  }

  if (results.length === 0) {
    console.log(`${DIM}No recent branches found.${RESET}`);
    return;
  }

  for (const r of results) {
    const dot = dotFor(r.status);
    const branchLink = link(r.branch, r.url);
    console.log(`${dot}  ${branchLink}`);
  }

  console.log(DIM + "─".repeat(sepWidth) + RESET);
  const failing = results.filter((r) => ["failed", "failing", "error"].includes(r.status)).length;
  const running = results.filter((r) => ["running", "on_hold"].includes(r.status)).length;
  const passing = results.filter((r) => r.status === "success").length;
  console.log(
    `${GREEN}${passing} passing${RESET}   ${YELLOW}${running} running${RESET}   ${RED}${failing} failing${RESET}`
  );
}

async function loop(): Promise<void> {
  try {
    const results = await fetchStatuses();
    render(results, null);
  } catch (err) {
    render([], err as Error);
  }
  setTimeout(loop, REFRESH_SECONDS * 1000);
}

process.stdout.write(HIDE_CURSOR);
process.on("exit", () => process.stdout.write(SHOW_CURSOR));
process.on("SIGINT", () => {
  process.stdout.write(SHOW_CURSOR);
  process.exit(0);
});

loop();
