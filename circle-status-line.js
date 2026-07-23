#!/usr/bin/env -S npx tsx

// ../../code/term-dash/circle-status-line.ts
var import_child_process = require("child_process");
var TOKEN = process.env.CIRCLECI_TOKEN;
var SLUG = "gh/Popmenu/popmenu";
var API = "https://circleci.com/api/v2";
var MAX_BRANCH_LEN = 35;
if (!TOKEN) {
  process.stdout.write("CI \u25CB no token");
  process.exit(0);
}
var RESET = "\x1B[0m";
var RED = "\x1B[31m";
var YELLOW = "\x1B[33m";
var GREEN = "\x1B[32m";
var GRAY = "\x1B[90m";
var DIM = "\x1B[2m";
function dot(status) {
  if (["failed", "failing", "error"].includes(status)) return `${RED}\u25CF${RESET}`;
  if (["running", "on_hold"].includes(status)) return `${YELLOW}\u25CF${RESET}`;
  if (status === "success") return `${GREEN}\u25CF${RESET}`;
  return `${GRAY}\u25CF${RESET}`;
}
function label(status) {
  if (["failed", "failing", "error"].includes(status)) return `${RED}${status}${RESET}`;
  if (["running", "on_hold"].includes(status)) return `${YELLOW}${status}${RESET}`;
  if (status === "success") return `${GREEN}${status}${RESET}`;
  return `${GRAY}${status}${RESET}`;
}
function trunc(s, max) {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}
function worstStatus(statuses) {
  const order = ["failed", "failing", "error", "running", "on_hold", "success"];
  for (const s of order) if (statuses.includes(s)) return s;
  return statuses[0] ?? "unknown";
}
async function cc(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Circle-Token": TOKEN }
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}
async function main() {
  let branch;
  try {
    branch = (0, import_child_process.execSync)("git rev-parse --abbrev-ref HEAD 2>/dev/null", { encoding: "utf8" }).trim();
    if (!branch || branch === "HEAD") throw new Error("detached");
  } catch {
    process.stdout.write(`${GRAY}CI \u25CB no branch${RESET}`);
    return;
  }
  const mine = await cc(`/project/${SLUG}/pipeline/mine`);
  const pipeline = mine.items.find((p) => {
    const b2 = p.vcs?.branch || p.trigger_parameters?.git?.branch || p.trigger_parameters?.github_app?.branch;
    return b2 === branch;
  });
  if (!pipeline) {
    process.stdout.write(`${DIM}CI \u25CB ${trunc(branch, MAX_BRANCH_LEN)}${RESET}`);
    return;
  }
  const wf = await cc(`/pipeline/${pipeline.id}/workflow`);
  if (!wf.items.length) {
    process.stdout.write(`${DIM}CI \u25CB ${trunc(branch, MAX_BRANCH_LEN)}${RESET}`);
    return;
  }
  const status = worstStatus(wf.items.map((w) => w.status));
  const d = dot(status);
  const l = label(status);
  const parts = branch.split("/");
  const displayBranch = parts.length >= 3 ? parts.slice(2).join("/") : branch;
  const b = trunc(displayBranch, MAX_BRANCH_LEN);
  process.stdout.write(`${d} ${DIM}${b}${RESET} \xB7 ${l}`);
}
main().catch(() => {
  process.stdout.write(`${GRAY}CI \u25CB error${RESET}`);
});
