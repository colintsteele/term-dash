#!/usr/bin/env -S npx tsx
/**
 * Single-line CircleCI status for Claude Code statusLine config.
 * Fetches the current git branch's latest pipeline, prints one line, exits.
 *
 * Output: ● branch-name · status
 *
 * Usage in ~/.claude/settings.json:
 *   "statusLine": {
 *     "type": "command",
 *     "command": "/Users/colinsteele/code/term-dash/circle-status-line.ts",
 *     "refreshInterval": 30
 *   }
 */

import { execSync } from "child_process";

const TOKEN = process.env.CIRCLECI_TOKEN;
const SLUG = "gh/Popmenu/popmenu";
const API = "https://circleci.com/api/v2";
const MAX_BRANCH_LEN = 35;

if (!TOKEN) {
  process.stdout.write("CI ○ no token");
  process.exit(0);
}

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const GRAY = "\x1b[90m";
const DIM = "\x1b[2m";

type WorkflowStatus =
  | "success" | "running" | "on_hold" | "failed"
  | "failing" | "error" | "canceled" | "not_run" | "unauthorized";

function dot(status: string): string {
  if (["failed", "failing", "error"].includes(status)) return `${RED}●${RESET}`;
  if (["running", "on_hold"].includes(status)) return `${YELLOW}●${RESET}`;
  if (status === "success") return `${GREEN}●${RESET}`;
  return `${GRAY}●${RESET}`;
}

function label(status: string): string {
  if (["failed", "failing", "error"].includes(status)) return `${RED}${status}${RESET}`;
  if (["running", "on_hold"].includes(status)) return `${YELLOW}${status}${RESET}`;
  if (status === "success") return `${GREEN}${status}${RESET}`;
  return `${GRAY}${status}${RESET}`;
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function worstStatus(statuses: WorkflowStatus[]): WorkflowStatus | "unknown" {
  const order: WorkflowStatus[] = ["failed", "failing", "error", "running", "on_hold", "success"];
  for (const s of order) if (statuses.includes(s)) return s;
  return statuses[0] ?? "unknown";
}

async function cc<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { "Circle-Token": TOKEN as string },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

async function main(): Promise<void> {
  let branch: string;
  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", { encoding: "utf8" }).trim();
    if (!branch || branch === "HEAD") throw new Error("detached");
  } catch {
    process.stdout.write(`${GRAY}CI ○ no branch${RESET}`);
    return;
  }

  const mine = await cc<{ items: Array<{ id: string; number: number; vcs?: { branch?: string }; trigger_parameters?: { git?: { branch?: string }; github_app?: { branch?: string } } }> }>(`/project/${SLUG}/pipeline/mine`);

  const pipeline = mine.items.find((p) => {
    const b = p.vcs?.branch || p.trigger_parameters?.git?.branch || p.trigger_parameters?.github_app?.branch;
    return b === branch;
  });

  if (!pipeline) {
    process.stdout.write(`${DIM}CI ○ ${trunc(branch, MAX_BRANCH_LEN)}${RESET}`);
    return;
  }

  const wf = await cc<{ items: Array<{ id: string; status: WorkflowStatus }> }>(`/pipeline/${pipeline.id}/workflow`);
  if (!wf.items.length) {
    process.stdout.write(`${DIM}CI ○ ${trunc(branch, MAX_BRANCH_LEN)}${RESET}`);
    return;
  }

  const status = worstStatus(wf.items.map((w) => w.status));
  const d = dot(status);
  const l = label(status);
  const parts = branch.split("/");
  const displayBranch = parts.length >= 3 ? parts.slice(2).join("/") : branch;
  const b = trunc(displayBranch, MAX_BRANCH_LEN);

  process.stdout.write(`${d} ${DIM}${b}${RESET} · ${l}`);
}

main().catch(() => {
  process.stdout.write(`${GRAY}CI ○ error${RESET}`);
});
