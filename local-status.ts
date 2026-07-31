#!/usr/bin/env -S npx tsx
/**
 * Compact local system status widget: CPU %, memory %, and whether
 * something's listening on port 3000 (with the actual process name, since
 * that port is shared turf between Rails/puma and Create React App's dev
 * server — this reports what's really there instead of guessing).
 *
 * The :3000 readout carries a rough memory total for that dev server — but for its
 * WHOLE process tree, not the listener alone. Under a Procfile runner (overmind /
 * foreman) the listener is just the Rails process; the bundler that actually leaks
 * across a few branch swaps (rspack, on its own port) is a SIBLING under the same
 * supervisor. Totalling only the listener would report a reassuring 0.7 GB while
 * the bundler eats 4. See getDevStackRssKb.
 *
 * Color thresholds (CPU/memory): dim <40%, yellow >=40%, orange >=60%, red >=80%.
 * Dev-stack memory uses the same four tiers against DEV_MEM_*_GB.
 *
 * Command/ctrl-click CPU or MEM to launch Activity Monitor — its path is
 * resolved via Spotlight (mdfind) rather than hardcoded, since it moved
 * between /Applications/Utilities and /System/Applications/Utilities
 * across macOS versions. Both currently open the app generally (no public
 * way to deep-link to a specific CPU/Memory tab via a plain URL click) —
 * see the project notes if you want true tab-specific opening via a small
 * Automator wrapper app.
 *
 * SETUP:
 *   npx tsx local-status.ts
 *   (no token needed — everything here is local)
 *
 * TESTING:
 *   npx tsx local-status.ts --mock
 *     Renders one fixed frame with fake numbers, no real sampling.
 */

import * as os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const POLL_SECONDS = 5; // local, cheap — fine to check often
const PORT_TO_WATCH = 3000;

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const YELLOW = "\x1b[33m";
const ORANGE = "\x1b[38;5;208m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";

function colorForPercent(pct: number): string {
  if (pct >= 80) return RED;
  if (pct >= 60) return ORANGE;
  if (pct >= 40) return YELLOW;
  return DIM;
}

// Dev-stack memory thresholds, in GB. These are WHOLE-TREE totals, not any single
// process — set them above your own idle baseline or everything reads as a warning.
// For reference, popmenu's `bin/dev` (puma + sidekiq + anycable + rpush + rspack +
// node-renderer + graphql-codegen) idles around 3.5–4 GB; the blowout case is rspack
// riding up against node's ~4 GB default heap ceiling, which drags the tree total
// into the 7–8 GB range and is the point where restarting beats waiting for the OOM.
const DEV_MEM_WARN_GB = 6;
const DEV_MEM_HIGH_GB = 7;
const DEV_MEM_HOT_GB = 8;

function colorForDevMem(gb: number): string {
  if (gb >= DEV_MEM_HOT_GB) return RED;
  if (gb >= DEV_MEM_HIGH_GB) return ORANGE;
  if (gb >= DEV_MEM_WARN_GB) return YELLOW;
  return DIM; // healthy — stays quiet next to the port label
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function link(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

// ---- CPU: sample os.cpus() twice a short interval apart, diff the ticks ----

function cpuSnapshot(): { idle: number; total: number }[] {
  return os.cpus().map((c) => {
    const total = c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    return { idle: c.times.idle, total };
  });
}

async function getCpuPercent(sampleMs = 300): Promise<number> {
  const start = cpuSnapshot();
  await sleep(sampleMs);
  const end = cpuSnapshot();

  let idleDiff = 0;
  let totalDiff = 0;
  for (let i = 0; i < start.length; i++) {
    idleDiff += end[i].idle - start[i].idle;
    totalDiff += end[i].total - start[i].total;
  }
  if (totalDiff <= 0) return 0;
  return Math.round(100 - (idleDiff / totalDiff) * 100);
}

// ---- Memory: vm_stat on macOS for an honest active+wired+compressed figure;
// falls back to os.totalmem/freemem elsewhere (less accurate on macOS, fine
// as a fallback on Linux/other) ----

async function getMemoryPercent(): Promise<number | null> {
  try {
    const { stdout } = await execAsync("vm_stat");
    const pageSizeMatch = stdout.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;

    const pages = (label: string): number => {
      const m = stdout.match(new RegExp(`${label}:\\s+(\\d+)`));
      return m ? parseInt(m[1], 10) : 0;
    };

    const free = pages("Pages free");
    const active = pages("Pages active");
    const inactive = pages("Pages inactive");
    const wired = pages("Pages wired down");
    const compressed = pages("Pages occupied by compressor");

    const used = (active + wired + compressed) * pageSize;
    const total = (free + active + inactive + wired + compressed) * pageSize;
    if (total <= 0) return null;
    return Math.round((used / total) * 100);
  } catch {
    // not macOS, or vm_stat unavailable — fall back to the generic (less
    // accurate on macOS, fine elsewhere) os module figures
    const total = os.totalmem();
    const free = os.freemem();
    if (total <= 0) return null;
    return Math.round(((total - free) / total) * 100);
  }
}

// ---- Port check: who (if anyone) is listening on PORT_TO_WATCH ----

// The PID comes back alongside the command name because it's the foothold
// getDevStackRssKb needs in the process tree.
async function getPortProcess(port: number): Promise<{ command: string; pid: number } | null> {
  try {
    const { stdout } = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    const lines = stdout.trim().split("\n");
    if (lines.length < 2) return null; // just the header, or empty
    const [command, pidStr] = lines[1].split(/\s+/);
    const pid = parseInt(pidStr, 10);
    if (!command || Number.isNaN(pid)) return null;
    return { command, pid };
  } catch {
    return null; // lsof exits non-zero when nothing matches, or isn't installed
  }
}

// ---- Dev-server memory: the listener's whole process tree ----

interface Proc {
  pid: number;
  ppid: number;
  rssKb: number; // resident set size, KB (what `ps` reports on macOS)
  command: string;
}

async function getProcTable(): Promise<Proc[]> {
  try {
    // maxBuffer well above the ~100 KB a few hundred processes produce, since some
    // command lines (Electron apps, in particular) are enormous.
    const { stdout } = await execAsync("ps -axo pid,ppid,rss,command", { maxBuffer: 8 * 1024 * 1024 });
    const procs: Proc[] = [];
    for (const line of stdout.split("\n").slice(1)) {
      // "  PID  PPID   RSS COMMAND" — the command is last and contains spaces, so
      // it takes everything after the three numeric columns.
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (m) procs.push({ pid: +m[1], ppid: +m[2], rssKb: +m[3], command: m[4] });
    }
    return procs;
  } catch {
    return [];
  }
}

// A process supervisor: if the port's listener has one of these as an ancestor, the
// whole dev stack hangs off it and that's what we want to total. popmenu's `bin/dev`
// is overmind, which runs each Procfile entry as an `sh` under a per-worktree
// `tmux -C -L overmind-<name>` — both carry "overmind" in argv, so one pattern
// catches the chain.
const DEV_SUPERVISOR_RE = /overmind|foreman|hivemind|Procfile|bin\/dev/;

// Rough RSS total, in KB, for the dev server rooted at the port's listener.
//
// Walk UP from the listener while the parent still looks like a supervisor, then sum
// the whole subtree under the highest one found. Bounding the climb by
// DEV_SUPERVISOR_RE is what keeps this honest: with a bare `rails s` in an editor
// terminal the parent is a shell, no match, so the root stays the server itself and
// we total it plus its cluster workers. Climbing blindly to the topmost ancestor
// would instead root at the editor's helper process and bill the whole IDE to the
// dev server. (Matching on directory or project name has the same failure — an
// editor's per-project processes carry that name too.)
//
// "Rough" is load-bearing: RSS counts pages shared between processes (the ~40 MB
// node binary, mapped once per process) once per process, so a 29-process tree
// overstates somewhat. Read it as a trend — "time to restart?" — not a true figure.
function getDevStackRssKb(listenerPid: number, procs: Proc[]): number | null {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  if (!byPid.has(listenerPid)) return null;

  let root = listenerPid;
  // Cap the climb: cheap insurance against a pathological/looping ppid chain.
  for (let i = 0; i < 8; i++) {
    const parent = byPid.get(byPid.get(root)!.ppid);
    if (!parent || parent.pid <= 1 || !DEV_SUPERVISOR_RE.test(parent.command)) break;
    root = parent.pid;
  }

  const kids = new Map<number, number[]>();
  for (const p of procs) {
    if (p.pid === p.ppid) continue; // self-parenting would loop the walk below
    const list = kids.get(p.ppid);
    if (list) list.push(p.pid);
    else kids.set(p.ppid, [p.pid]);
  }

  let total = 0;
  const seen = new Set<number>();
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += byPid.get(pid)?.rssKb ?? 0;
    for (const k of kids.get(pid) ?? []) stack.push(k);
  }
  return total;
}

// One decimal under 10 GB, none above — a rough number shouldn't imply precision it
// doesn't have, and this keeps the label to 3–4 chars at any scale. Below 1 GB it
// switches to MB: a bare `node` dev server is tens of megabytes, and "37M" says that
// where "0.0G" just looks broken.
function formatMem(kb: number): string {
  const gb = kb / 1048576;
  if (gb < 1) return `${Math.round(kb / 1024)}M`;
  return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)}G`;
}

function describePort(port: { command: string; pid: number } | null, devMemKb: number | null): string {
  if (!port) return `${DIM}:${PORT_TO_WATCH} —${RESET}`;
  const color = /ruby|puma|rails/i.test(port.command)
    ? GREEN
    : /node/i.test(port.command)
      ? CYAN
      : YELLOW;
  // Memory rides just after the process name. Omitted (not zeroed) when the tree
  // couldn't be read, so a failed `ps` costs the line nothing but the number.
  const mem =
    devMemKb !== null
      ? ` ${colorForDevMem(devMemKb / 1048576)}${formatMem(devMemKb)}${RESET}`
      : "";
  return `${color}:${PORT_TO_WATCH} ${port.command}${RESET}${mem}`;
}

// ---- Activity Monitor location, resolved once via Spotlight (not hardcoded —
// its path has moved across macOS versions) and cached for the process lifetime ----

let cachedActivityMonitorUrl: string | null | undefined; // undefined = not resolved yet

function pathToFileUrl(path: string): string {
  return "file://" + path.split("/").map(encodeURIComponent).join("/");
}

async function getActivityMonitorUrl(): Promise<string | null> {
  if (cachedActivityMonitorUrl !== undefined) return cachedActivityMonitorUrl;
  try {
    const { stdout } = await execAsync(
      `mdfind "kMDItemCFBundleIdentifier == 'com.apple.ActivityMonitor'"`
    );
    const path = stdout.trim().split("\n")[0];
    cachedActivityMonitorUrl = path ? pathToFileUrl(path) : null;
  } catch {
    cachedActivityMonitorUrl = null;
  }
  return cachedActivityMonitorUrl;
}

// ---- render ----

function render(
  cpuPct: number,
  memPct: number | null,
  portProcess: { command: string; pid: number } | null,
  devMemKb: number | null,
  activityMonitorUrl: string | null
): void {
  process.stdout.write("\x1b[3J\x1b[2J\x1b[H"); // clear scrollback + screen + home, not a full reset (\x1Bc)

  let cpuLabel = `CPU ${cpuPct}%`;
  if (activityMonitorUrl) cpuLabel = link(cpuLabel, activityMonitorUrl);
  const cpuStr = `${colorForPercent(cpuPct)}${cpuLabel}${RESET}`;

  let memLabel = memPct !== null ? `MEM ${memPct}%` : "MEM —";
  if (activityMonitorUrl) memLabel = link(memLabel, activityMonitorUrl);
  const memStr = memPct !== null ? `${colorForPercent(memPct)}${memLabel}${RESET}` : `${DIM}${memLabel}${RESET}`;

  const portStr = describePort(portProcess, devMemKb);

  console.log(`${cpuStr}   ${memStr}   ${portStr}`);
}

async function loop(): Promise<void> {
  try {
    // The process table is fetched in parallel with the port lookup rather than
    // after it: they're independent reads, and the tree walk that joins them is
    // pure in-memory work once both have landed.
    const [cpuPct, memPct, portProcess, procs, activityMonitorUrl] = await Promise.all([
      getCpuPercent(),
      getMemoryPercent(),
      getPortProcess(PORT_TO_WATCH),
      getProcTable(),
      getActivityMonitorUrl(),
    ]);
    const devMemKb = portProcess ? getDevStackRssKb(portProcess.pid, procs) : null;
    render(cpuPct, memPct, portProcess, devMemKb, activityMonitorUrl);
  } catch (err) {
    process.stdout.write("\x1b[3J\x1b[2J\x1b[H");
    console.log(`⚠️  ${(err as Error).message}`);
  }
  setTimeout(loop, POLL_SECONDS * 1000);
}

// ---- entry point ----

if (process.argv.includes("--mock")) {
  // 6.6 GB lands in the yellow tier, so --mock exercises the memory colouring
  // rather than showing the dim healthy case.
  render(
    42,
    67,
    { command: "puma", pid: 1234 },
    6_920_000,
    "file:///Applications/Utilities/Activity%20Monitor.app"
  );
} else {
  process.stdout.write(HIDE_CURSOR);
  process.on("exit", () => process.stdout.write(SHOW_CURSOR));
  process.on("SIGINT", () => {
    process.stdout.write(SHOW_CURSOR);
    process.exit(0);
  });
  loop();
}
