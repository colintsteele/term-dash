#!/usr/bin/env -S npx tsx
/**
 * Compact local system status widget: CPU %, memory %, and whether
 * something's listening on port 3000 (with the actual process name, since
 * that port is shared turf between Rails/puma and Create React App's dev
 * server — this reports what's really there instead of guessing).
 *
 * Color thresholds (CPU/memory): dim <40%, yellow >=40%, orange >=60%, red >=80%.
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

async function getPortProcess(port: number): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    const lines = stdout.trim().split("\n");
    if (lines.length < 2) return null; // just the header, or empty
    const command = lines[1].split(/\s+/)[0];
    return command || null;
  } catch {
    return null; // lsof exits non-zero when nothing matches, or isn't installed
  }
}

function describePort(command: string | null): string {
  if (!command) return `${DIM}:${PORT_TO_WATCH} —${RESET}`;
  const color = /ruby|puma|rails/i.test(command)
    ? GREEN
    : /node/i.test(command)
      ? CYAN
      : YELLOW;
  return `${color}:${PORT_TO_WATCH} ${command}${RESET}`;
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
  portCommand: string | null,
  activityMonitorUrl: string | null
): void {
  process.stdout.write("\x1b[3J\x1b[2J\x1b[H"); // clear scrollback + screen + home, not a full reset (\x1Bc)

  let cpuLabel = `CPU ${cpuPct}%`;
  if (activityMonitorUrl) cpuLabel = link(cpuLabel, activityMonitorUrl);
  const cpuStr = `${colorForPercent(cpuPct)}${cpuLabel}${RESET}`;

  let memLabel = memPct !== null ? `MEM ${memPct}%` : "MEM —";
  if (activityMonitorUrl) memLabel = link(memLabel, activityMonitorUrl);
  const memStr = memPct !== null ? `${colorForPercent(memPct)}${memLabel}${RESET}` : `${DIM}${memLabel}${RESET}`;

  const portStr = describePort(portCommand);

  console.log(`${cpuStr}   ${memStr}   ${portStr}`);
}

async function loop(): Promise<void> {
  try {
    const [cpuPct, memPct, portCommand, activityMonitorUrl] = await Promise.all([
      getCpuPercent(),
      getMemoryPercent(),
      getPortProcess(PORT_TO_WATCH),
      getActivityMonitorUrl(),
    ]);
    render(cpuPct, memPct, portCommand, activityMonitorUrl);
  } catch (err) {
    process.stdout.write("\x1b[3J\x1b[2J\x1b[H");
    console.log(`⚠️  ${(err as Error).message}`);
  }
  setTimeout(loop, POLL_SECONDS * 1000);
}

// ---- entry point ----

if (process.argv.includes("--mock")) {
  render(42, 67, "puma", "file:///Applications/Utilities/Activity%20Monitor.app");
} else {
  process.stdout.write(HIDE_CURSOR);
  process.on("exit", () => process.stdout.write(SHOW_CURSOR));
  process.on("SIGINT", () => {
    process.stdout.write(SHOW_CURSOR);
    process.exit(0);
  });
  loop();
}
