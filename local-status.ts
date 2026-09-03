#!/usr/bin/env -S npx tsx
/**
 * The dashboard's top strip: one full-width line spanning every column, laid
 * out in three justified segments.
 *
 *   14:47  Mon Aug 25  ◷ 18m Standup    KEYS ✗ CIRCLECI dead    CPU 23%  MEM 74%  SSH :2223 ✓  :3000 ruby 3.6G
 *   └────────────── left ──────────────┘   └───── centered ─────┘   └──────────────── right ──────────────────┘
 *
 * The middle is the only segment that ever shouts, and it is a ranked alert
 * channel rather than a status field: it shows nothing at all when nothing is
 * wrong. Sources are ranked in rankAlerts — an imminent meeting outranks a key
 * problem, because a key stays actionable all day and a meeting starting in two
 * minutes does not. The winner takes the space; a lower-ranked alert joins it
 * only if it fits whole.
 *
 * Time, next meeting and machine
 * vitals are fixed furniture you read positionally — always the same place, usually dim —
 * so anything centered and red is by construction the thing that wants you.
 * Centering (rather than a left-packed line) is what makes that work: the alert
 * lands in the middle of your visual field regardless of how wide the terminal
 * is or how long the vitals happen to render.
 *
 * Segments are composed as plain text and colored last, because centering needs
 * a true visible width and ANSI/OSC-8 bytes would inflate it — see visibleWidth
 * and layoutStrip.
 *
 * Reports CPU %, memory %, and whether something's listening on port 3000 (with
 * the actual process name, since that port is shared turf between Rails/puma
 * and Create React App's dev server — this reports what's really there instead
 * of guessing).
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
 * SSH :2223 is remote access from the personal laptop, and it is the one cell
 * here that is actionable rather than merely informative: red means the door is
 * shut, and command-clicking it runs bin/ssh-2223-up.sh behind the macOS admin
 * prompt — which starts sshd and installs the LaunchDaemon that brings it back
 * at every boot. Liveness comes from netstat rather than lsof; see
 * isPortListening for why an lsof probe reports it down the entire time it is up.
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
 *   The next-meeting segment needs two one-time steps:
 *     1. ./build-nextmeeting.sh          compile the EventKit helper
 *     2. add the M365 account under System Settings -> Internet Accounts,
 *        calendars only. New Outlook cannot be scripted for events (it answers
 *        for `calendar 1` and reports zero of them), so the calendar has to
 *        reach the local EventKit store via Calendar.app. Confirm with
 *        `./bin/nextmeeting --calendars`, which lists what EventKit can see.
 *   Until then the segment is simply absent, and the strip is the clock and
 *   date. A permission prompt refused shows a dim `CAL ?` instead, since that
 *   is the one failure that never fixes itself.
 *
 * TESTING:
 *   npx tsx local-status.ts --mock
 *     Renders one fixed frame with fake numbers, no real sampling.
 *   npx tsx local-status.ts --mock --imminent
 *     Same, but with the meeting 2 minutes out, so the center hands over from
 *     KEYS to the meeting and both alerts compete for the budget.
 *   npx tsx local-status.ts --mock --mins=12
 *     An arbitrary countdown. The two canned values (18 and 2) sit either side
 *     of the alert window, so this is the only way to land ON the
 *     MEETING_IMMINENT_MIN boundary and see which side it falls.
 *   COLUMNS=100 npx tsx local-status.ts --mock
 *     Same frame at a forced width — the useful way to check the layout
 *     degrades sanely (center truncates, then drops) without resizing anything.
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const POLL_SECONDS = 5; // local, cheap — fine to check often
const PORT_TO_WATCH = 3000;

// SSH from the personal laptop. Not a dev-server port like the one above — this
// is remote access, and its failure mode is asymmetric: you discover it is down
// at the moment you are away from the machine and can no longer start it. That
// asymmetry is what earns it a permanent cell instead of an alert when broken.
const SSH_PORT = 2223;
// Command-click target for the SSH cell when it is down. Built by
// ./build-ssh-app.sh — an app bundle rather than a plain script, because
// LaunchServices launches apps and merely opens scripts. Same constraint the
// Activity Monitor links work around.
const SSH_START_APP = path.join(os.homedir(), "Applications", "Start SSH 2223.app");

// API-key expiry. Written by ~/.zsh-sources/bin/key-check, which a launchd agent
// runs daily. We only read the cache — never keys.zsh itself — so this widget
// never touches secret material, and a 5s poll costs one small file read rather
// than re-running network viability tests.
const KEYCHECK_CACHE = path.join(os.homedir(), ".cache", "keycheck.json");
// A cache older than this means the daily agent stopped running. That is itself
// worth surfacing: silence from a dead checker looks identical to "all healthy".
const KEYCHECK_STALE_HOURS = 36;

// Next meeting. bin/nextmeeting reads the local EventKit store — see
// nextmeeting.swift for why we go through Calendar.app instead of scripting
// Outlook directly. Resolved from argv[1] rather than a hardcoded path so the
// checkout can live anywhere.
const NEXTMEETING_BIN = path.join(
  path.dirname(fs.realpathSync(process.argv[1] ?? ".")),
  "bin",
  "nextmeeting"
);
// Meetings don't move on a 5s cadence, and each call spins up EventKit. Cache
// the event and recompute the countdown locally on every frame, so the strip
// still ticks down once a minute without re-reading the calendar.
const MEETING_TTL_MS = 60_000;
// Title budget, wide and narrow — counted in words, not columns. Real invites
// run long ("Popmenu <> Vendor Weekly — Q3 Planning"), and a column cut lands
// mid-word ("Popmenu <> Vendor Weekl…"), which reads as a rendering bug rather
// than as an elision. Six words identifies any invite on the calendar; three is
// enough to recognize one you already know about, which is all the narrow
// variant is for. The clock is still the thing that must survive, so the layout
// drops to narrow and then to clock-only if these don't fit.
const MEETING_TITLE_WORDS = 6;
const MEETING_TITLE_WORDS_NARROW = 3;
// The window in which a meeting stops being furniture and claims the center
// alert channel: from MEETING_IMMINENT_MIN before it starts to
// MEETING_LATE_GRACE_MIN after. The grace side has to be bounded — a meeting you
// are 40 minutes into is not an alert, it's a fact, and leaving it in the center
// would mask every key failure for the length of the meeting.
//
// 15, not 5: five minutes is enough time to notice a meeting, not enough to
// finish a thought, close a branch and walk to a room. Fifteen is the same
// warning Outlook's own default reminder gives, so the strip and the desktop
// notification now agree instead of the strip lagging ten minutes behind it.
// The cost is that a meeting owns the center for up to 20 minutes (15 + grace),
// but it does not MASK the keys alert — rankAlerts still returns both and
// buildCenter fits the second one beside it whenever the budget allows.
const MEETING_IMMINENT_MIN = 15;
const MEETING_LATE_GRACE_MIN = 5;
// Between ranked center sources. Dim, so it reads as punctuation rather than
// as part of either alert.
const ALERT_SEP = "  ·  ";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const YELLOW = "\x1b[33m";
const ORANGE = "\x1b[38;5;208m";
// ANSI 4, not Outlook's literal #0078D4. The exact brand value was measurably
// correct and looked wrong — a saturated 24-bit blue sitting next to this
// palette's yellows and greens reads as a foreign object dropped on the strip.
// The basic colour is whatever the terminal scheme calls blue, so it is tuned to
// the same background everything else here was tuned against, and it matches the
// ◂ dev marker in cursor-status.ts. Same reasoning as the rest of this palette
// being 3x/9x codes rather than fixed RGB; ORANGE is the lone exception because
// no basic slot means orange.
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";
const BRIGHT_RED = "\x1b[91m"; // key expiry — deliberately louder than the CPU/MEM red
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

// Swap thresholds, in GB. The first tier starts just above zero rather than at
// some comfortable number, because on a 48 GB machine any swap at all is the
// interesting event: it means the compressor ran out of headroom and macOS
// started paying disk for memory. MEM% climbing is routine; this is not.
const SWAP_HIGH_GB = 4;
const SWAP_HOT_GB = 8;

function colorForSwap(gb: number): string {
  if (gb >= SWAP_HOT_GB) return RED;
  if (gb >= SWAP_HIGH_GB) return ORANGE;
  return YELLOW; // non-zero at all — never dim, that's the whole point of it
}

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

// ---- strip layout: left / centered / right on one full-width line ----

// SGR color runs and OSC-8 hyperlink wrappers. Both occupy bytes and zero
// columns, so every width measurement has to see past them.
const INVISIBLE_RE = /\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;]*m/g;

// Terminals render emoji and CJK at two columns, and miscounting even one glyph
// slides the centered segment off true — the alignment this file exists to get
// right. This used to be a near-theoretical concern when every glyph was ours
// (✗/✓ in the keys segment, both narrow; ◷ in the meeting segment, also narrow).
// It isn't anymore: meeting titles are arbitrary text off someone's calendar,
// and invites really do arrive titled "🎉 Team Social", so the wide ranges below
// are now load-bearing rather than defensive.
function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp === 0x26a1 || // ⚡ — wide despite living in Misc Symbols
    (cp >= 0x1f300 && cp <= 0x1f64f) || // emoji + pictographs
    (cp >= 0x1f900 && cp <= 0x1f9ff)
  ) {
    return 2;
  }
  return 1;
}

function visibleWidth(s: string): number {
  let w = 0;
  // Iterating the string yields whole code points, so a surrogate pair counts
  // once — .length would score it as two.
  for (const ch of s.replace(INVISIBLE_RE, "")) w += charWidth(ch.codePointAt(0)!);
  return w;
}

// COLUMNS is honored so the layout can be exercised at a fixed width with output
// piped (process.stdout.columns is undefined off a tty). Falls back wide rather
// than to 80: under tmux this pane spans the whole window, and guessing narrow
// would needlessly drop the center segment on the first frame.
function stripWidth(): number {
  const forced = parseInt(process.env.COLUMNS ?? "", 10);
  if (Number.isFinite(forced) && forced > 0) return forced;
  return process.stdout.columns || 120;
}

/**
 * Place `center` at the true midpoint of the line, with `left` flush left and
 * `right` flush right — then give up gracefully as the width runs out.
 *
 * The midpoint is the line's, not the gap's: the center segment sits where your
 * eye already is, instead of drifting with the length of the vitals on either
 * side. That costs nothing while there's room and is the entire reason this is
 * centered rather than packed.
 *
 * Degradation order, worst case last:
 *   1. shrink the padding around the center, down to one space a side
 *   2. truncate the center to what's left (caller pre-trims to keep it meaningful)
 *   3. drop the center entirely and keep left/right justified
 *   4. drop the right segment too — at this width there is nothing to align
 */
function layoutStrip(left: string, center: string, right: string, width: number): string {
  const l = visibleWidth(left);
  const r = visibleWidth(right);
  const c = visibleWidth(center);

  if (l + r + 1 > width) return left; // (4) nothing fits alongside the clock
  if (c === 0 || l + r + c + 2 > width) {
    // (3) no room for a center; justify what's left
    return left + " ".repeat(width - l - r) + right;
  }

  // (1) ideal start column for the center, clamped to leave a space each side
  const ideal = Math.floor((width - c) / 2);
  const padLeft = Math.max(1, Math.min(ideal - l, width - l - r - c - 1));
  const padRight = width - l - padLeft - c - r;
  return left + " ".repeat(padLeft) + center + " ".repeat(padRight) + right;
}

// Truncation happens on plain text, before color is applied — slicing a string
// that already carries SGR codes would cut one in half and bleed the color into
// the rest of the line.
function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(text) <= max) return text;
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max - 1) break; // -1 leaves room for the ellipsis
    out += ch;
    w += cw;
  }
  return out + "…";
}

// Word-wise elision, for text that a human wrote and will read back: cutting on
// a space keeps every word that survives intact. Whitespace collapses on the way
// through, which is deliberate — calendar titles arrive with stray runs of it
// from copy-paste and from Outlook's own subject munging.
function truncateWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  // Trailing punctuation-only tokens go with the elision. Invite titles are full
  // of standalone separators ("Popmenu <> Vendor Weekly Sync — Q3 Planning"), and
  // landing the cut just after one leaves a dangling "Sync —…" that reads as a
  // stray character rather than as a shortened title.
  const kept = words.slice(0, maxWords);
  while (kept.length > 1 && !/[\p{L}\p{N}]/u.test(kept[kept.length - 1]!)) kept.pop();
  return kept.join(" ") + "…";
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
// Swap in use, in KB. Read from sysctl rather than derived from vm_stat: the
// compressor pages that getMemoryPercent counts as "used" are RAM, not swap, and
// conflating the two is exactly the confusion this cell exists to clear up.
async function getSwapUsedKb(): Promise<number | null> {
  try {
    const { stdout } = await execAsync("sysctl -n vm.swapusage");
    // "total = 2048.00M  used = 1234.50M  free = 813.50M  (encrypted)"
    const m = stdout.match(/used\s*=\s*([\d.]+)([KMG])/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = m[2].toUpperCase();
    return unit === "G" ? n * 1048576 : unit === "M" ? n * 1024 : n;
  } catch {
    return null;
  }
}

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

// Whether anything is listening on a TCP port. Asked of netstat rather than the
// lsof above, and the difference is load-bearing rather than stylistic: lsof run
// unprivileged cannot see sockets owned by other users, sshd is root, so an lsof
// probe reports 2223 closed for the whole time SSH is working perfectly. netstat
// reads the kernel socket table and has no such blind spot. The trade is that it
// cannot name the owning process, which costs nothing here — "is the door open"
// is the entire question.
async function isPortListening(port: number): Promise<boolean> {
  try {
    const { stdout } = await execAsync("netstat -an -p tcp");
    // "tcp4  0  0  *.2223  *.*  LISTEN" — the local address is the 4th column.
    // The leading dot is what stops a listener on :12223 from matching :2223.
    const suffix = `.${port}`;
    return stdout.split("\n").some((line) => {
      const cols = line.trim().split(/\s+/);
      return cols[5] === "LISTEN" && (cols[3]?.endsWith(suffix) ?? false);
    });
  } catch {
    return false; // no netstat, or it failed — don't claim the port is open
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

// Absent while swap is empty — which is the normal state, and the reason this
// cell costs nothing on a typical day. MEM% already answers "how full is memory";
// swap answers the rarer and sharper question of whether that fullness has begun
// costing disk. A permanent "SWAP 0" would spend columns to say "no".
function describeSwap(usedKb: number | null): string | null {
  if (usedKb === null || usedKb <= 0) return null;
  return `${colorForSwap(usedKb / 1048576)}SWAP ${formatMem(usedKb)}${RESET}`;
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

// The SSH cell: quiet ✓ while the door is open, red ✗ when it is not — and when
// it is not, the label is one command-click from fixing itself. Only the broken
// state carries the link, since clicking a healthy cell would raise a password
// prompt in order to do nothing.
function describeSsh(up: boolean, startUrl: string | null): string {
  if (up) return `${DIM}SSH :${SSH_PORT} ✓${RESET}`;
  const label = `SSH :${SSH_PORT} ✗`;
  return `${RED}${startUrl ? link(label, startUrl) : label}${RESET}`;
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

// Absent until ./build-ssh-app.sh has been run, in which case the cell renders
// unlinked rather than offering a click that goes nowhere. Checked per frame and
// not cached, so building the app lights the link up without a restart.
function getSshStartUrl(): string | null {
  return fs.existsSync(SSH_START_APP) ? pathToFileUrl(SSH_START_APP) : null;
}

// ---- API key expiry ----

interface KeyEntry {
  name: string;
  state: "failing" | "expired" | "expiring" | "unknown" | "untestable" | "ok";
  detail: string;
  days_left: number | null;
}

interface KeyReport {
  checked_at: string;
  keys: KeyEntry[];
  needs_attention: string[];
  worst: string;
}

function readKeyReport(): KeyReport | null {
  try {
    return JSON.parse(fs.readFileSync(KEYCHECK_CACHE, "utf8")) as KeyReport;
  } catch {
    return null; // never run, or mid-write — treat as "nothing to say"
  }
}

// The center segment: plain text plus the color to paint it, kept separate so
// layoutStrip can measure and truncate before any escape bytes exist.
interface Segment {
  text: string;
  color: string;
  href?: string; // OSC-8 target, applied after measuring — zero columns
  // A badge-sized version of the same alert, for when it loses the center to a
  // higher-ranked one and the full wording will not fit beside it. Not a
  // truncation: it has to stay unambiguous on its own, because that is the whole
  // point of showing it at all.
  compact?: string;
}

// Worst first, at most three names, then a +N tail. The strip is full-width now,
// so three fits comfortably where the old 15%-wide column could only show two.
//
// An alert ticker, not a status field: silence is the healthy state, so a report
// with nothing urgent in it renders as an empty center. Silence is still not
// proof of health on its own — it means "checked recently, nothing to say", and
// the two ways that can go wrong both stay loud: no cache at all is `KEYS ?`,
// and a cache the daily checker stopped refreshing trips the stale branch below.
function describeKeys(report: KeyReport | null): Segment {
  if (!report) return { text: "KEYS ?", color: DIM };

  const ageHours = (Date.now() - new Date(report.checked_at).getTime()) / 3_600_000;
  if (Number.isFinite(ageHours) && ageHours > KEYCHECK_STALE_HOURS) {
    const days = Math.floor(ageHours / 24);
    return {
      text: `KEYS stale ${days}d — key-check not running`,
      color: YELLOW,
      compact: `KEYS stale`,
    };
  }

  const rank: Record<string, number> = { failing: 0, expired: 1, expiring: 2 };
  const urgent = report.keys
    .filter((k) => k.state in rank)
    .sort((a, b) => rank[a.state] - rank[b.state] || (a.days_left ?? 0) - (b.days_left ?? 0));

  if (urgent.length === 0) return { text: "", color: DIM };

  const short = (k: KeyEntry) => {
    if (k.state === "failing") return `${k.name} dead`;
    if (k.state === "expired") return `${k.name} EXPIRED`;
    return `${k.name} ${k.days_left}d`;
  };

  const shown = urgent.slice(0, 3).map(short).join(", ");
  const rest = urgent.length > 3 ? ` +${urgent.length - 3}` : "";
  // The count, not the names: "KEYS ✗3" says go look, which is all a badge can
  // honestly do. A half-truncated name would say the wrong thing instead.
  return {
    text: `KEYS ✗ ${shown}${rest}`,
    color: BRIGHT_RED,
    compact: `KEYS ✗${urgent.length}`,
  };
}

// ---- clock + next meeting: the left segment ----

// 12-hour to match the timestamps the other panels print ("updated 3:14 PM"),
// so the whole dashboard reads in one convention.
function formatClock(now: Date): string {
  return now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function formatDate(now: Date): string {
  // en-US renders this as "Tue, Aug 25"; the comma buys nothing in a status
  // strip and the segment is tighter without it.
  return now
    .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
    .replace(",", "");
}

interface MeetingEvent {
  title: string;
  start: string;
  end: string;
  minutes_until: number;
  in_progress: boolean;
  all_day: boolean;
  location?: string;
  join_url?: string;
  calendar: string;
}

interface MeetingReport {
  checked_at: string;
  access: string; // granted | denied | restricted | unknown
  error?: string;
  next?: MeetingEvent; // absent, not null: Swift's synthesized Encodable omits nil keys
  later_count: number;
}

let cachedMeeting: { at: number; report: MeetingReport | null } | null = null;

async function getNextMeeting(): Promise<MeetingReport | null> {
  if (cachedMeeting && Date.now() - cachedMeeting.at < MEETING_TTL_MS) {
    return cachedMeeting.report;
  }
  let report: MeetingReport | null = null;
  try {
    const { stdout } = await execAsync(`"${NEXTMEETING_BIN}"`, { timeout: 10_000 });
    report = JSON.parse(stdout) as MeetingReport;
  } catch {
    // Not built yet, or EventKit is wedged behind an unanswered prompt. Either
    // way the strip omits the segment rather than showing a stale meeting.
    report = null;
  }
  cachedMeeting = { at: Date.now(), report };
  return report;
}

// "18m" beats "11:00 AM" here: there is already a clock two segments to the
// left, and what you actually want off a glance is the gap, not the time.
function formatUntil(mins: number): string {
  if (mins <= 0) return "now";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

// Both readouts need the same three facts, and the parsing is fiddly enough
// (absent keys, unparseable dates, an event that ended inside the cache window)
// that doing it twice would mean two places to get it wrong.
interface MeetingNow {
  ev: MeetingEvent;
  mins: number; // minutes until start; negative once it has begun
}

// Countdown is computed here rather than read from the report, because the
// report is up to MEETING_TTL_MS old and a frozen "18m" is worse than no
// number at all.
function resolveMeeting(report: MeetingReport | null, now: Date): MeetingNow | null {
  if (!report || report.access !== "granted") return null;
  const ev = report.next;
  if (!ev) return null;

  const startMs = new Date(ev.start).getTime();
  const endMs = new Date(ev.end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  // Ended inside the cache window — say nothing until the next refresh picks up
  // whatever is genuinely next.
  if (endMs <= now.getTime()) return null;

  return { ev, mins: Math.round((startMs - now.getTime()) / 60_000) };
}

function withJoinLink(label: string, ev: MeetingEvent): string {
  // Cmd-click to join. The URL is invisible to visibleWidth (OSC-8), so this
  // costs the layout nothing.
  return ev.join_url ? link(label, ev.join_url) : label;
}

// The left segment: permanently dim, no exceptions. It is positional furniture
// like the clock beside it — you look there when you want to know, and it never
// asks. Everything urgent about a meeting is the center's job now.
function describeMeetingCalm(report: MeetingReport | null, now: Date, titleWords: number): string {
  // A denied prompt is the one calendar failure worth a pixel: it is
  // indistinguishable from an empty day otherwise, and it never fixes itself.
  if (report && report.access !== "granted") return `${DIM}CAL ?${RESET}`;

  // Promoted to the center: printing it on both sides burns the columns the
  // center needs to also fit a key alert beside it, and reads as two meetings.
  // Once the alert window closes the left picks it up again for the duration,
  // so coverage is continuous.
  if (describeMeetingAlert(report, now)) return "";

  const m = resolveMeeting(report, now);
  if (!m) return "";
  const label = `◷ ${formatUntil(m.mins)} ${truncateWords(m.ev.title, titleWords)}`;
  return `${DIM}${withJoinLink(label, m.ev)}${RESET}`;
}

// The center segment. Returns null outside the alert window, which is the normal
// case — the meeting is still on the left the whole time.
function describeMeetingAlert(report: MeetingReport | null, now: Date): Segment | null {
  const m = resolveMeeting(report, now);
  if (!m) return null;
  if (m.mins > MEETING_IMMINENT_MIN || m.mins < -MEETING_LATE_GRACE_MIN) return null;

  const when =
    m.mins > 0 ? `in ${formatUntil(m.mins)}` : m.mins === 0 ? "now" : `${-m.mins}m late`;
  // Blue while it is still ahead of you, so the alert is recognisably the same
  // object as the invite it came from — you read the colour before you read the
  // words. Orange once it has STARTED, and that split is deliberate:
  // past the start time this is no longer a warning about the future, it is a
  // thing already happening without you, and it should stop matching the calm
  // brand colour at exactly the moment it stops being calm.
  return {
    text: `◷ ${when} — ${truncateWords(m.ev.title, MEETING_TITLE_WORDS)}`,
    color: m.mins > 0 ? BLUE : ORANGE,
    href: m.ev.join_url,
  };
}

// Ranked, highest priority first. An imminent meeting outranks a key problem:
// keys go bad over days and you can act on them any time today, whereas a
// meeting starting in two minutes is actionable for exactly two minutes.
function rankAlerts(v: Vitals): Segment[] {
  const out: Segment[] = [];
  const meeting = describeMeetingAlert(v.meeting, v.now);
  if (meeting) out.push(meeting);
  if (v.keys.text) out.push(v.keys);
  return out;
}

// The winner always gets the space it needs, truncated if that is all there is.
// A lower-ranked alert then tries its full wording, falls back to its compact
// badge, and is dropped only if even that will not fit. What it never does is
// appear truncated: cut off mid-word it reads as noise, and can be misread as
// part of the alert beside it.
//
// Composed as plain text and measured before any color is applied, because
// visibleWidth has to see past SGR bytes and truncate must never slice one.
function buildCenter(alerts: Segment[], budget: number): string {
  if (alerts.length === 0 || budget <= 0) return "";

  const sepWidth = visibleWidth(ALERT_SEP);
  const chosen: { text: string; color: string; href?: string }[] = [];
  let used = 0;

  for (const a of alerts) {
    if (chosen.length === 0) {
      const text = truncate(a.text, budget);
      if (!text) return "";
      chosen.push({ text, color: a.color, href: a.href });
      used = visibleWidth(text);
      continue;
    }
    const forms = [a.text, a.compact].filter((t): t is string => !!t);
    const fits = forms.find((t) => used + sepWidth + visibleWidth(t) <= budget);
    if (!fits) continue; // no room for this one; a later, shorter alert may still fit
    chosen.push({ text: fits, color: a.color, href: a.href });
    used += sepWidth + visibleWidth(fits);
  }

  return chosen
    .map((c) => `${c.color}${c.href ? link(c.text, c.href) : c.text}${RESET}`)
    .join(`${DIM}${ALERT_SEP}${RESET}`);
}

// ---- render ----

interface Vitals {
  now: Date;
  cpuPct: number;
  memPct: number | null;
  portProcess: { command: string; pid: number } | null;
  devMemKb: number | null;
  swapUsedKb: number | null;
  activityMonitorUrl: string | null;
  sshUp: boolean;
  sshStartUrl: string | null;
  meeting: MeetingReport | null;
  keys: Segment;
}

// Kept so a resize can redraw immediately at the new width instead of showing a
// line justified to the old one until the next poll, up to POLL_SECONDS away.
let lastVitals: Vitals | null = null;

// Both flanking segments are built widest-first, so a narrow terminal sheds the
// least useful parts (the date, then the port readout) instead of losing a whole
// side of the strip. Dropping the vitals to keep the date would be exactly
// backwards.
function buildLeftVariants(v: Vitals): string[] {
  const clock = formatClock(v.now);
  const date = `${DIM}${formatDate(v.now)}${RESET}`;
  const wide = describeMeetingCalm(v.meeting, v.now, MEETING_TITLE_WORDS);
  const narrow = describeMeetingCalm(v.meeting, v.now, MEETING_TITLE_WORDS_NARROW);
  // The meeting outranks the date on the way down — the date is the one thing
  // here you already know.
  return [
    [clock, date, wide].filter(Boolean).join("  "),
    [clock, date, narrow].filter(Boolean).join("  "),
    [clock, narrow].filter(Boolean).join("  "),
    clock,
  ];
}

function buildRightVariants(v: Vitals): string[] {
  let cpuLabel = `CPU ${v.cpuPct}%`;
  if (v.activityMonitorUrl) cpuLabel = link(cpuLabel, v.activityMonitorUrl);
  const cpuStr = `${colorForPercent(v.cpuPct)}${cpuLabel}${RESET}`;

  let memLabel = v.memPct !== null ? `MEM ${v.memPct}%` : "MEM —";
  if (v.activityMonitorUrl) memLabel = link(memLabel, v.activityMonitorUrl);
  const memStr =
    v.memPct !== null
      ? `${colorForPercent(v.memPct)}${memLabel}${RESET}`
      : `${DIM}${memLabel}${RESET}`;

  const swap = describeSwap(v.swapUsedKb);
  const ssh = describeSsh(v.sshUp, v.sshStartUrl);
  const port = describePort(v.portProcess, v.devMemKb);
  // SSH and SWAP ride in both variants; the dev-server readout is the one that
  // sheds on a narrow terminal. You can confirm :3000 by glancing at the browser,
  // and there is no equivalent glance for either of the other two. SWAP costs
  // nothing to keep, since it is only present at all when it is non-zero.
  const core = [cpuStr, memStr, swap, ssh].filter(Boolean) as string[];
  return [[...core, port].join("  "), core.join("  ")];
}

// Widest pair of variants that still leaves a gap between them; the last (i.e.
// narrowest) pair if none do — layoutStrip handles the rest.
function pickVariants(lefts: string[], rights: string[], width: number): [string, string] {
  for (const left of lefts) {
    for (const right of rights) {
      if (visibleWidth(left) + visibleWidth(right) + 1 <= width) return [left, right];
    }
  }
  return [lefts[lefts.length - 1], rights[rights.length - 1]];
}

function render(v: Vitals): void {
  lastVitals = v;
  process.stdout.write("\x1b[3J\x1b[2J\x1b[H"); // clear scrollback + screen + home, not a full reset (\x1Bc)

  const width = stripWidth();
  const [left, right] = pickVariants(buildLeftVariants(v), buildRightVariants(v), width);

  // Budget for the center before coloring it: whatever a single space either
  // side of the vitals leaves. buildCenter measures and truncates plain text and
  // colors last, so the SGR wrappers are always well-formed.
  const budget = width - visibleWidth(left) - visibleWidth(right) - 2;
  const center = buildCenter(rankAlerts(v), budget);

  // No trailing newline: in a 1-row pane a newline scrolls the line we just
  // drew off the top.
  process.stdout.write(layoutStrip(left, center, right, width));
}

async function loop(): Promise<void> {
  try {
    // Independent reads, so they all go out at once; the process-tree walk that
    // joins the port lookup to `ps` is pure in-memory work once both have landed.
    const [cpuPct, memPct, swapUsedKb, portProcess, procs, activityMonitorUrl, meeting, sshUp] =
      await Promise.all([
        getCpuPercent(),
        getMemoryPercent(),
        getSwapUsedKb(),
        getPortProcess(PORT_TO_WATCH),
        getProcTable(),
        getActivityMonitorUrl(),
        getNextMeeting(),
        isPortListening(SSH_PORT),
      ]);
    render({
      now: new Date(),
      cpuPct,
      memPct,
      portProcess,
      devMemKb: portProcess ? getDevStackRssKb(portProcess.pid, procs) : null,
      swapUsedKb,
      activityMonitorUrl,
      sshUp,
      sshStartUrl: getSshStartUrl(),
      meeting,
      keys: describeKeys(readKeyReport()),
    });
  } catch (err) {
    process.stdout.write("\x1b[3J\x1b[2J\x1b[H");
    process.stdout.write(`⚠️  ${(err as Error).message}`);
  }
  setTimeout(loop, POLL_SECONDS * 1000);
}

// ---- entry point ----

if (process.argv.includes("--mock")) {
  // --imminent puts the meeting inside the alert window, which is the only way
  // to see the center hand over from KEYS to the meeting without waiting for a
  // real one. Both alerts are live in that frame, so it also exercises the
  // fits-whole-or-drop rule in buildCenter.
  //
  // --mins=N overrides both. The two fixed values sit either side of the alert
  // window and nothing reaches the band between them, which is exactly where
  // MEETING_IMMINENT_MIN now lives — `--mock --mins=12` is how you check the
  // boundary moved without waiting for a real 12-minutes-out meeting.
  const minsFlag = process.argv.find((a) => a.startsWith("--mins="));
  const mockMins = minsFlag
    ? Number(minsFlag.slice("--mins=".length))
    : process.argv.includes("--imminent")
      ? 2
      : 18;
  // 6.6 GB lands in the yellow tier and the keys segment is populated, so one
  // --mock frame exercises the memory colouring and the loud center at once.
  render({
    now: new Date(),
    cpuPct: 42,
    memPct: 67,
    // Non-zero on purpose: an empty swap renders no cell at all, so the mock would
    // otherwise never show this code path.
    swapUsedKb: 2_306_867,
    portProcess: { command: "puma", pid: 1234 },
    devMemKb: 6_920_000,
    activityMonitorUrl: "file:///Applications/Utilities/Activity%20Monitor.app",
    // Rendered down, because red is the state worth eyeballing — the healthy one
    // is a dim tick you will see every other minute of the day.
    sshUp: false,
    sshStartUrl: "file:///Users/you/Applications/Start%20SSH%202223.app",
    meeting: {
      checked_at: new Date().toISOString(),
      access: "granted",
      next: {
        title: "Popmenu <> Vendor Weekly Sync",
        start: new Date(Date.now() + mockMins * 60_000).toISOString(),
        end: new Date(Date.now() + (mockMins + 30) * 60_000).toISOString(),
        minutes_until: mockMins,
        in_progress: false,
        all_day: false,
        join_url: "https://teams.microsoft.com/l/meetup-join/mock",
        calendar: "Calendar",
      },
      later_count: 3,
    },
    // Through describeKeys rather than a hand-written string, so the mock frame
    // reflects real ranking, the +N tail and the compact badge. The literal it
    // replaced had drifted: it showed two names next to a "+1" that the actual
    // slice(0, 3) could never produce.
    keys: describeKeys({
      checked_at: new Date().toISOString(),
      worst: "failing",
      needs_attention: ["CIRCLECI_TOKEN"],
      keys: [
        { name: "CIRCLECI_TOKEN", state: "failing", detail: "", days_left: null },
        { name: "SHORTCUT_RO_TOKEN", state: "expired", detail: "", days_left: 0 },
        { name: "GITHUB_TOKEN", state: "expiring", detail: "", days_left: 3 },
        { name: "NOTION_TOKEN", state: "expiring", detail: "", days_left: 9 },
      ],
    }),
  });
  process.stdout.write("\n");
} else {
  process.stdout.write(HIDE_CURSOR);
  process.on("exit", () => process.stdout.write(SHOW_CURSOR));
  process.on("SIGINT", () => {
    process.stdout.write(SHOW_CURSOR);
    process.exit(0);
  });
  // Justification is width-dependent, so a resize has to redraw now rather than
  // wait out the poll interval. Reuses the last sample: re-measuring CPU here
  // would mean a 300 ms sleep on every drag frame.
  process.stdout.on("resize", () => {
    if (lastVitals) render(lastVitals);
  });
  loop();
}
