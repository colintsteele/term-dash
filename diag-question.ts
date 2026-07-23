#!/usr/bin/env -S npx tsx
/**
 * Diagnose why a Cursor agent's pending question isn't showing as !! in the
 * Worktrees panel (cursor-status.ts). RUN IT WHILE THE QUESTION IS STILL ON
 * SCREEN UNANSWERED — the "loading" tool status disappears the instant you
 * answer, so a capture taken afterward can't tell us anything.
 *
 *   npx tsx diag-question.ts <substring>
 *
 * <substring> matches the worktree path/branch (e.g. "enumerate" or "sc-170267").
 * It walks the exact same pipeline as the panel and prints where the signal is
 * lost. Paste the whole output back to me — that's all the context I need.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const CURSOR_DB = path.join(HOME, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
const RESOLVED = new Set(["submitted", "cancelled", "error"]);
const needle = (process.argv[2] || "").toLowerCase();

function db(query: string): string {
  return execFileSync("sqlite3", ["-readonly", CURSOR_DB, query], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000, maxBuffer: 32 * 1024 * 1024,
  });
}
function liveDirs(): Set<string> {
  const s = new Set<string>();
  try {
    for (const l of execFileSync("ps", ["-axo", "command"], { encoding: "utf8" }).split("\n")) {
      const m = l.match(/\(agent-exec\)\s+(.+?)\s+\[\d+-\d+\]/);
      if (m) s.add(m[1].trim());
    }
  } catch {}
  return s;
}

console.log(`now: ${new Date().toLocaleTimeString()}   DB exists: ${fs.existsSync(CURSOR_DB)}`);
try { execFileSync("sqlite3", ["--version"], { stdio: "ignore" }); console.log("sqlite3: ok"); }
catch { console.log("sqlite3: MISSING — pendingQuestion() would always return false"); }

const projects = path.join(HOME, ".cursor", "projects");
const matches = fs.readdirSync(projects).filter((d) => d.toLowerCase().includes(needle));
if (!needle) { console.log("\nPass a worktree/branch substring. Candidates:"); fs.readdirSync(projects).forEach((d) => console.log("  " + d)); process.exit(0); }
if (matches.length === 0) { console.log(`\nNo ~/.cursor/projects dir matches "${needle}".`); process.exit(0); }

const live = liveDirs();
for (const proj of matches) {
  console.log(`\n════ project: ${proj}`);
  const wtBase = proj.split("-").pop() || "";
  console.log(`  live agent-exec process (basename match): ${[...live].some((n) => proj.endsWith(n)) || live.has(wtBase)}  (live: ${[...live].join(", ") || "none"})`);
  const tdir = path.join(projects, proj, "agent-transcripts");
  let uuids: string[] = [];
  try { uuids = fs.readdirSync(tdir); } catch { console.log("  no agent-transcripts dir"); continue; }

  for (const uuid of uuids) {
    console.log(`  ── composer ${uuid}`);
    // transcript open-turn check (gates baseState === "running")
    const jf = path.join(tdir, uuid, `${uuid}.jsonl`);
    try {
      const lines = fs.readFileSync(jf, "utf8").split(/\r?\n/).filter((l) => l.trim());
      const last = JSON.parse(lines[lines.length - 1]);
      const age = Math.round((Date.now() - fs.statSync(jf).mtimeMs) / 1000);
      console.log(`     transcript: lastType=${last.type || "role:" + last.role}  openTurn=${last.type !== "turn_ended"}  mtime=${age}s ago`);
    } catch (e) { console.log(`     transcript: unreadable (${(e as Error).message})`); }

    // DB: last tool call + ask_question status (the decisive check)
    let composer: string;
    try { composer = db(`SELECT value FROM cursorDiskKV WHERE key='composerData:${uuid}';`); }
    catch (e) { console.log(`     DB composerData: read FAILED (${(e as Error).message})`); continue; }
    if (!composer.trim()) { console.log("     DB composerData: NO ROW (uuid not a composer here)"); continue; }
    let o: any;
    try { o = JSON.parse(composer); } catch { console.log("     DB composerData: unparseable JSON"); continue; }
    const hs: any[] = o.fullConversationHeadersOnly || [];
    console.log(`     DB: headers=${hs.length}  generatingBubbleIds=${JSON.stringify(o.generatingBubbleIds)}  topStatus(stale)=${o.status}`);
    let lastTool: any;
    for (let i = hs.length - 1; i >= 0; i--) if (hs[i]?.grouping?.toolCallCase) { lastTool = hs[i]; break; }
    if (!lastTool) { console.log("     last tool call: NONE"); continue; }
    console.log(`     last tool call: ${lastTool.grouping.toolCallCase}  (createdAt ${lastTool.createdAt})`);
    if (lastTool.grouping.toolCallCase !== "askQuestionToolCall") { console.log("     → not an AskQuestion; pendingQuestion=false (a later tool ran, or it's mid-work)"); continue; }
    try {
      const bubble = db(`SELECT value FROM cursorDiskKV WHERE key='bubbleId:${uuid}:${lastTool.bubbleId}';`);
      const tf = JSON.parse(bubble)?.toolFormerData || {};
      const answer = tf?.additionalData?.status; // "pending" until answered, then submitted/cancelled/error
      const pending = typeof answer === "string" && !RESOLVED.has(answer);
      console.log(`     askQuestion answer status=${JSON.stringify(answer)} (outer=${JSON.stringify(tf.status)})  → pendingQuestion=${pending}${pending ? "  ✅ SHOULD SHOW !!" : "  (answered/settled → cleared)"}`);
    } catch (e) { console.log(`     askQuestion bubble: read FAILED (${(e as Error).message})`); }
  }
}
