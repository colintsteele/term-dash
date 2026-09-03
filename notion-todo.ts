#!/usr/bin/env -S npx tsx
/**
 * Notion ToDo pane — this week's list, scrollable + clickable
 *
 * Reads the most recent weekly heading on the page (an M/D heading like "8/24")
 * and renders its to_do children as a live list:
 *   - click a row      → toggle checked (stays visible, drawn struck-through)
 *   - wheel / arrows   → scroll
 *   - type + Enter     → append a new to-do under the same heading
 *
 * Requires: NOTION_TOKEN + NOTION_PAGE_ID env vars, npx tsx
 *   NOTION_PAGE_ID is the target page's 32-char id (with or without dashes),
 *   e.g. the trailing segment of its notion.so URL.
 *
 * Mouse input needs tmux `set -g mouse on` (already set in ~/.tmux.conf) — tmux
 * forwards events to a pane once the program in it asks for them, which is what
 * the DECSET 1000/1006 sequences below do.
 */

const TOKEN = process.env.NOTION_TOKEN;
const PAGE_ID = process.env.NOTION_PAGE_ID;
const API = "https://api.notion.com/v1";
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

/** How often to re-read the page, so edits made in Notion itself show up here. */
const POLL_MS = 45_000;

if (!TOKEN) {
  console.error("NOTION_TOKEN is not set.");
  process.exit(1);
}

if (!PAGE_ID) {
  console.error("NOTION_PAGE_ID is not set.");
  process.exit(1);
}

// ── ANSI ─────────────────────────────────────────────────────────────────────
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const STRIKE = "\x1b[9m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
// 1000h = report button press/release, 1006h = SGR encoding (works past col 95)
const MOUSE_ON  = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1000l";

// ── Types ─────────────────────────────────────────────────────────────────────
interface RichText { plain_text: string }
interface Block {
  id: string;
  type: string;
  has_children?: boolean;
  to_do?: { rich_text: RichText[]; checked: boolean };
  toggle?: { rich_text: RichText[] };
  heading_1?: { rich_text: RichText[] };
  heading_2?: { rich_text: RichText[] };
  heading_3?: { rich_text: RichText[] };
  [key: string]: unknown;
}
interface NotionList { results: Block[]; has_more: boolean; next_cursor: string | null }

interface Todo {
  id: string;
  text: string;
  checked: boolean;
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function notion<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message ?? `Notion ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Fetch ALL children of a block, handling pagination. */
async function fetchChildren(blockId: string): Promise<Block[]> {
  const blocks: Block[] = [];
  let cursor: string | null = null;

  do {
    const qs: string = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const page = await notion<NotionList>("GET", `/blocks/${blockId}/children${qs}`);
    blocks.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);

  return blocks;
}

function blockText(b: Block): string {
  const inner = b.heading_1 ?? b.heading_2 ?? b.heading_3 ?? b.toggle ?? b.to_do;
  if (inner && "rich_text" in inner) {
    return (inner as { rich_text: RichText[] }).rich_text
      .map((r) => r.plain_text)
      .join("")
      .trim();
  }
  return "";
}

/**
 * The week headings are plain M/D text ("8/24", "2 /30"), and the page also
 * carries stray paragraphs and orphaned to_dos between sections — so pick the
 * LAST heading that looks like a date rather than the last block on the page.
 */
function isWeekHeading(b: Block): boolean {
  if (!b.type.startsWith("heading")) return false;
  return /^\d{1,2}\s*\/\s*\d{1,2}/.test(blockText(b));
}

async function findCurrentWeek(): Promise<Block> {
  const blocks = await fetchChildren(PAGE_ID!);
  const headings = blocks.filter(isWeekHeading);
  if (headings.length === 0) throw new Error("No M/D week heading found on the page.");
  return headings[headings.length - 1];
}

async function fetchTodos(headingId: string): Promise<Todo[]> {
  const children = await fetchChildren(headingId);
  return children
    .filter((b) => b.type === "to_do")
    .map((b) => ({
      id: b.id,
      text: blockText(b),
      checked: b.to_do?.checked ?? false,
    }))
    .filter((t) => t.text.length > 0);
}

async function appendTodo(headingId: string, text: string): Promise<void> {
  await notion("PATCH", `/blocks/${headingId}/children`, {
    children: [
      {
        type: "to_do",
        to_do: {
          rich_text: [{ type: "text", text: { content: text } }],
          checked: false,
        },
      },
    ],
  });
}

async function setChecked(blockId: string, checked: boolean): Promise<void> {
  await notion("PATCH", `/blocks/${blockId}`, { to_do: { checked } });
}

// ── State ─────────────────────────────────────────────────────────────────────
let heading: Block | null = null;
let todos: Todo[] = [];
let scroll = 0;
let input = "";
let status = "";
let statusColor = DIM;
let statusTimer: NodeJS.Timeout | null = null;
/** Display row (0-based, within the list viewport) → index into `todos`. */
let rowMap: number[] = [];

function setStatus(msg: string, color = DIM, clearAfterMs = 0): void {
  status = msg;
  statusColor = color;
  if (statusTimer) clearTimeout(statusTimer);
  if (clearAfterMs) {
    statusTimer = setTimeout(() => {
      status = "";
      render();
    }, clearAfterMs);
  }
  render();
}

// ── Render ────────────────────────────────────────────────────────────────────
const size = () => ({
  w: Math.max(12, process.stdout.columns || 40),
  h: Math.max(4, process.stdout.rows || 12),
});

/** Wrap to width, breaking on spaces where possible. */
function wrap(text: string, width: number): string[] {
  if (width < 2) return [text.slice(0, Math.max(1, width))];
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

/** Every visual line of the list, flattened, each tagged with its to-do index. */
function buildLines(w: number): { text: string; todo: number }[] {
  const lines: { text: string; todo: number }[] = [];
  todos.forEach((t, i) => {
    const box = t.checked ? "[x] " : "[ ] ";
    const body = wrap(t.text, Math.max(4, w - 4));
    body.forEach((chunk, n) => {
      const prefix = n === 0 ? box : "    ";
      const style = t.checked ? `${DIM}${STRIKE}` : "";
      lines.push({ text: `${style}${prefix}${chunk}${RESET}`, todo: i });
    });
  });
  return lines;
}

function render(): void {
  const { w, h } = size();
  const viewport = Math.max(1, h - 2); // header + input line
  const lines = buildLines(w);

  scroll = Math.max(0, Math.min(scroll, Math.max(0, lines.length - viewport)));

  const done = todos.filter((t) => t.checked).length;
  const title = heading ? blockText(heading).replace(/\s+/g, "") : "…";
  let header = `${BOLD}${CYAN}◆ ${title}${RESET} ${DIM}${done}/${todos.length}${RESET}`;
  if (lines.length > viewport) {
    const more = lines.length - viewport - scroll;
    header += `${DIM}${scroll > 0 ? " ↑" : ""}${more > 0 ? " ↓" : ""}${RESET}`;
  }
  if (status) header = `${statusColor}${status}${RESET}`;

  const out: string[] = [HIDE_CURSOR, "\x1b[H"];
  out.push(header + "\x1b[K");

  rowMap = [];
  for (let r = 0; r < viewport; r++) {
    const line = lines[scroll + r];
    out.push(`\r\n${line ? line.text : ""}\x1b[K`);
    rowMap.push(line ? line.todo : -1);
  }

  // Input line: keep the tail visible once typing runs past the pane width.
  const prompt = "› ";
  const room = Math.max(1, w - prompt.length - 1);
  const shown = input.length > room ? input.slice(input.length - room) : input;
  out.push(`\r\n${BOLD}${CYAN}${prompt}${RESET}${shown}\x1b[K`);
  out.push(`\x1b[${h};${prompt.length + shown.length + 1}H`, SHOW_CURSOR);

  process.stdout.write(out.join(""));
}

// ── Data loading ──────────────────────────────────────────────────────────────
let loading = false;

async function reload(showSpinner = false): Promise<void> {
  if (loading) return;
  loading = true;
  if (showSpinner) setStatus("⟳ loading…", YELLOW);
  try {
    if (!heading) heading = await findCurrentWeek();
    todos = await fetchTodos(heading.id);
    if (showSpinner) setStatus("", DIM);
    else render();
  } catch (err) {
    setStatus(`✗ ${(err as Error).message}`, RED, 6000);
  } finally {
    loading = false;
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function submit(): Promise<void> {
  const text = input.trim();
  if (!text || !heading) return;
  input = "";
  setStatus("⟳ adding…", YELLOW);

  // Optimistic: show it immediately, scrolled into view, then reconcile.
  todos.push({ id: `pending-${todos.length}`, text, checked: false });
  scroll = Number.MAX_SAFE_INTEGER;
  render();

  try {
    await appendTodo(heading.id, text);
    todos = await fetchTodos(heading.id);
    scroll = Number.MAX_SAFE_INTEGER;
    setStatus(`${GREEN}✓${RESET} added`, DIM, 2000);
  } catch (err) {
    todos.pop();
    setStatus(`✗ ${(err as Error).message}`, RED, 6000);
  }
}

async function toggle(index: number): Promise<void> {
  const todo = todos[index];
  if (!todo || todo.id.startsWith("pending-")) return;

  todo.checked = !todo.checked;
  render();

  try {
    await setChecked(todo.id, todo.checked);
  } catch (err) {
    todo.checked = !todo.checked;
    setStatus(`✗ ${(err as Error).message}`, RED, 6000);
  }
}

// ── Input ─────────────────────────────────────────────────────────────────────
function scrollBy(delta: number): void {
  scroll = Math.max(0, scroll + delta);
  render();
}

/** SGR mouse report: ESC [ < btn ; col ; row (M=press, m=release) */
function handleMouse(btn: number, _col: number, row: number, press: boolean): void {
  if (btn === 64) return scrollBy(-1); // wheel up
  if (btn === 65) return scrollBy(1);  // wheel down
  if (!press || (btn & 3) !== 0) return; // left button press only

  const viewportRow = row - 2; // row 1 is the header, rows are 1-based
  if (viewportRow < 0 || viewportRow >= rowMap.length) return;
  const index = rowMap[viewportRow];
  if (index >= 0) void toggle(index);
}

function cleanup(): void {
  process.stdout.write(MOUSE_OFF + SHOW_CURSOR + "\x1b[?1049l");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

/** Held between reads when a chunk ends mid-escape-sequence. */
let pending = "";

function handleKeys(data: string): void {
  const chunk = pending + data;
  pending = "";
  let i = 0;
  while (i < chunk.length) {
    const c = chunk[i];

    if (c === "\x1b") {
      const rest = chunk.slice(i);
      // A truncated sequence: wait for the remainder rather than typing it.
      if (/^\x1b(\[[<\d;]*)?$/.test(rest)) {
        pending = rest;
        return;
      }
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
      if (mouse) {
        handleMouse(+mouse[1], +mouse[2], +mouse[3], mouse[4] === "M");
        i += mouse[0].length;
        continue;
      }
      const seq = /^\x1b\[([A-D]|\d+~)/.exec(rest);
      if (seq) {
        const { h } = size();
        const page = Math.max(1, h - 3);
        if (seq[1] === "A") scrollBy(-1);
        else if (seq[1] === "B") scrollBy(1);
        else if (seq[1] === "5~") scrollBy(-page);
        else if (seq[1] === "6~") scrollBy(page);
        i += seq[0].length;
        continue;
      }
      i++; // lone ESC / unrecognised sequence
      continue;
    }

    if (c === "\x03" || c === "\x04") { // Ctrl+C / Ctrl+D
      cleanup();
      process.exit(0);
    }
    if (c === "\x12") { // Ctrl+R — force refresh
      heading = null;
      void reload(true);
      i++;
      continue;
    }
    if (c === "\x15") { // Ctrl+U — clear the input line
      input = "";
      render();
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      void submit();
      i++;
      continue;
    }
    if (c === "\x7f" || c === "\b") {
      input = input.slice(0, -1);
      render();
      i++;
      continue;
    }
    if (c >= " ") {
      input += c;
      render();
      i++;
      continue;
    }
    i++;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error("notion-todo needs a TTY (run it in a tmux pane).");
    process.exit(1);
  }

  process.stdout.write("\x1b[?1049h" + MOUSE_ON); // alternate screen, no scrollback churn
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", handleKeys);

  process.stdout.on("resize", render);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => { cleanup(); process.exit(0); });
  }
  process.on("exit", cleanup);

  render();
  await reload(true);
  setInterval(() => { void reload(false); }, POLL_MS);
}

void main();
