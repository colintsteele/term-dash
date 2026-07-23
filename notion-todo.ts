#!/usr/bin/env -S npx tsx
/**
 * Notion ToDo pane — always-on tmux input
 * Type a to-do item, hit Enter → appended under the most recent weekly toggle (M/D format).
 *
 * Requires: NOTION_TOKEN + NOTION_PAGE_ID env vars, npx tsx
 *   NOTION_PAGE_ID is the target page's 32-char id (with or without dashes),
 *   e.g. the trailing segment of its notion.so URL.
 */

import * as readline from "readline";

const TOKEN = process.env.NOTION_TOKEN;
const PAGE_ID = process.env.NOTION_PAGE_ID;
const API = "https://api.notion.com/v1";
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

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
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";

// ── Types ─────────────────────────────────────────────────────────────────────
interface RichText { plain_text: string }
interface Block {
  id: string;
  type: string;
  toggle?: { rich_text: RichText[] };
  heading_1?: { rich_text: RichText[]; is_toggleable?: boolean };
  heading_2?: { rich_text: RichText[]; is_toggleable?: boolean };
  heading_3?: { rich_text: RichText[]; is_toggleable?: boolean };
  [key: string]: unknown;
}
interface NotionList { results: Block[]; has_more: boolean; next_cursor: string | null }

// ── API helpers ───────────────────────────────────────────────────────────────
async function notion<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json() as { message?: string };
    throw new Error(err.message ?? `Notion ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** Fetch ALL top-level blocks on the page, handling pagination. */
async function fetchAllBlocks(): Promise<Block[]> {
  const blocks: Block[] = [];
  let cursor: string | null = null;

  do {
    const qs = cursor ? `?start_cursor=${cursor}` : "";
    const page = await notion<NotionList>("GET", `/blocks/${PAGE_ID}/children${qs}`);
    blocks.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);

  return blocks;
}

/** Extract a display title from whichever content key the block has. */
function blockTitle(b: Block): string {
  const inner = b.heading_1 ?? b.heading_2 ?? b.heading_3 ?? b.toggle;
  if (inner && "rich_text" in inner) {
    return (inner as { rich_text: RichText[] }).rich_text[0]?.plain_text ?? b.type;
  }
  return b.type;
}

/** Return the last top-level block on the page (used as the append target). */
async function findLastBlock(): Promise<Block> {
  const blocks = await fetchAllBlocks();
  if (blocks.length === 0) throw new Error("No blocks found on the page.");
  return blocks[blocks.length - 1];
}

/** Append a to_do block under the given toggle. */
async function appendTodo(toggleId: string, text: string): Promise<void> {
  await notion("PATCH", `/blocks/${toggleId}/children`, {
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

// ── UI helpers ────────────────────────────────────────────────────────────────
function printHeader(): void {
  console.clear();
  console.log(`${BOLD}${CYAN}◆ Notion ToDo${RESET}`);
  console.log(DIM + "─".repeat(40) + RESET);
}

function printStatus(msg: string): void {
  process.stdout.write(`\r${" ".repeat(60)}\r${msg}`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  printHeader();
  console.log(`${DIM}Type a to-do and press Enter. Ctrl+C to exit.${RESET}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${BOLD}${CYAN}›${RESET} `,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const text = line.trim();

    if (!text) {
      rl.prompt();
      return;
    }

    printStatus(`${YELLOW}⟳ Adding…${RESET}`);

    try {
      const target = await findLastBlock();
      const title = blockTitle(target).trim() || target.type;
      await appendTodo(target.id, text);

      process.stdout.write(`\r${" ".repeat(60)}\r`);
      console.log(`${GREEN}✓${RESET} ${DIM}${title}${RESET}  ${text}`);
    } catch (err) {
      process.stdout.write(`\r${" ".repeat(60)}\r`);
      console.log(`${RED}✗${RESET} ${(err as Error).message}`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log(`\n${DIM}bye${RESET}`);
    process.exit(0);
  });
}

main();
