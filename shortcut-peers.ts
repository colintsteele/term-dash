#!/usr/bin/env -S npx tsx
/**
 * Peers panel — what everyone else on the team is working on, one block per
 * developer:
 *
 *   Tonia Saba
 *    ⎿ sc-174391 👀 kb edit settings button
 *    ⎿ sc-175445    sms scheduling guard
 *   Jose Medeiros
 *    ⎿ sc-175457    mobile calendar render
 *
 * The glyph is where YOU stand on that peer's PR:
 *   👀  waiting on you — you never filed a review, or the author re-requested you
 *   💬  you are in the conversation but have not signed off
 *   ✅  you approved it
 * They sort in that order inside each block, so what you owe floats to the top and
 * is the last thing fitToBudget will hide behind a "+N".
 *
 * The pane shows every peer's whole list when it fits, which it normally does.
 * Rows are handed out by fitToBudget() against PEERS_MAX_ROWS rather than by a
 * flat per-peer cap; a "+N" on the name line means the TEAM had more active work
 * than the pane has rows, not that the pane arbitrarily stopped at two.
 *
 * There is no title row, here or in the worktrees panel above. Every row belongs
 * to a peer.
 *
 * This is the outward-facing counterpart to the Worktrees panel. That one answers
 * "what am I in the middle of"; this one answers "what is everyone else in the
 * middle of", which is the question you actually have before standup and when
 * deciding whether the thing you are about to pick up is already someone's.
 *
 * ── Why a 2-3 word summary and not the ticket title ───────────────────────
 * Shortcut titles are written to be unambiguous in a backlog, not legible in a
 * 55-column pane: "Do not create SMS campaigns scheduled in the past (Atlas
 * import)" spends its first 30 characters before it says anything you cannot
 * guess. Truncation lands mid-clause and reads as a rendering bug. So each title
 * is compressed once by `claude -p` into 2-3 words and cached on disk forever.
 * Keyed on story id + title, so a retitled ticket re-summarises and every other
 * ticket costs nothing ever again. Steady state is zero LLM calls per poll.
 *
 * Same mechanism as the Sentry summaries in morning-brief.ts — deliberately, so
 * there is one summarise-and-cache pattern in this repo rather than two. It
 * degrades to a truncated title if `claude` is missing, unauthenticated, slow or
 * returns junk, and TERMDASH_NO_LLM=1 turns it off outright. A pane must never
 * fail to draw because a nicety failed.
 *
 * ── Why PEERS is a constant and not derived at runtime ────────────────────
 * Membership of the Shortcut team is not the question — the team includes QA,
 * design and product, and this pane is about developers. There IS a reliable
 * rule for telling them apart, and `--classify` implements it: a developer is
 * someone whose mention_name is the leading segment of branch names attached to
 * the team's stories (Popmenu branches are `<mention>/sc-<id>/<slug>`).
 *
 * That rule is run on demand, not per poll, for two reasons. It costs one detail
 * request per story (branches are absent from the search payload), which is far
 * too much for a five-minute cadence. And its failure mode is silent: a developer
 * who happened not to push inside the sample window simply vanishes from the
 * pane, which looks identical to "has nothing on". A stale constant fails loudly
 * and visibly instead, and the roster changes about twice a year.
 *
 * DO NOT classify on "owns stories that have branches or PRs attached". That
 * measures the TICKET, not the person: QA are assigned as owner during the QA
 * phase, by which time the developer's PR is long since attached. Annie Wu owns
 * more of this team's stories than anyone and has authored zero branches.
 *
 * SETUP:
 *   export SHORTCUT_RO_TOKEN=...      # same token the other widgets use
 *   npx tsx shortcut-peers.ts
 *
 * MAINTENANCE:
 *   npx tsx shortcut-peers.ts --classify    # re-derive PEERS, prints a paste-able line
 *
 * TESTING:
 *   npx tsx shortcut-peers.ts --once        # one frame, then exit
 *   COLUMNS=40 npx tsx shortcut-peers.ts --once
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

// ---- config ----

const SHORTCUT_TOKEN = process.env.SHORTCUT_RO_TOKEN;
const SHORTCUT_API = "https://api.app.shortcut.com/api/v3";
const SC_SLUG = "popmenu"; // app.shortcut.com/<SC_SLUG>/story/<id>
const SC_TEAM_NAME = "Marketeers";

// The states that mean "this is what they are on right now". Matches
// SC_REVIEW_STATE_NAMES in git-notiql.ts on purpose: a ticket sitting in review
// is still its author's active work, and dropping it the moment they open a PR
// would make people flicker out of the pane while they are most engaged with it.
// ONE colour in this pane, and it means one thing: you can act on this now.
//
// Every state used to get its own colour — green in-dev, amber QA, purple merge —
// and the result was a pane where four things shouted and none of them were the
// thing you were looking for. A colour per state answers "where is this in the
// pipeline", which the pane cannot do anything about; grey-except-review answers
// "is this mine to pick up", which is why you look at it.
const SC_BLUE = "\x1b[38;5;75m"; // ready for review — your move

// The columns this pane watches, in pipeline order. QA and merge-ready are here
// so a peer mid-pipeline does not read as having nothing on; they are just grey.
//
// Ready for Deploy / Ready for Approval are deliberately NOT here: past merge it
// is release management, not what someone is working on.
const SC_STATES: { name: string; review: boolean }[] = [
  { name: "In Development", review: false },
  { name: "Ready for Review", review: true },
  { name: "Ready for QA", review: false },
  { name: "In QA", review: false },
  { name: "Ready for Merge", review: false },
];
const SC_STATE_NAMES = SC_STATES.map((s) => s.name);

// Developers on SC_TEAM_NAME, by Shortcut mention_name, excluding yourself.
// Regenerate with --classify; see the header for why this is a constant.
// Last derived 2026-08-27 from 90 recent stories.
const PEERS = ["toniasaba", "josemedeiros", "andrewzimmer", "carolflores"];

// A per-peer CEILING, not a quota. It used to be 2, which meant the pane
// routinely hid work it had the rows to show — the whole team's active tickets
// are typically well inside PEERS_MAX_ROWS, so a flat cap of 2 was collapsing
// tickets into "+N" while the pane sat half empty. Worse, "+N" is blind to
// whether the hidden ticket is one waiting on YOU.
//
// So the real limit is the shared row budget in fitToBudget(), and this is only
// the point past which one person's list stops being a glance. "+N" still
// appears, but now only when the team genuinely has more work than fits.
const MAX_TICKETS_PER_PEER = 6;

const POLL_MINUTES = 5;

// ---- your standing on each peer's PR (GitHub) ----
//
// Marks the tickets whose PR is sitting on YOU. Same rule as the REVIEWS section
// of morning-brief.ts, deliberately: never reviewed by you, or re-requested of
// you. One rule, two surfaces.
//
// Joined to Shortcut by BRANCH NAME, not by a Shortcut detail request. Popmenu
// branches are `<mention>/sc-<id>/<slug>`, so the story id is already in
// headRefName — which means this costs ONE GitHub call per poll instead of one
// Shortcut call per story. That per-story cost is exactly what the header says is
// too much for a five-minute cadence, so we do not pay it.
//
// The two search qualifiers do the filtering server-side: `-reviewed-by` IS "you
// never filed a review" (a bare comment is not a review), and
// `review-requested:` IS "re-requested", because GitHub drops you from that list
// when you review and puts you back when the author asks again.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GRAPHQL_URL = "https://api.github.com/graphql";
const MY_LOGIN = "colintsteele";
const GH_REPO = "Popmenu/popmenu";
// Where YOU stand on each peer's ticket. One glyph per state, all two columns
// wide so the summaries beside them stay on one left edge.
type MyState = "awaiting" | "commented" | "approved";
const STATE_GLYPH: Record<MyState, string> = {
  awaiting: "👀", // never filed a review, or the author re-requested you
  commented: "💬", // you are in the conversation but have not signed off
  approved: "✅", // you approved it; nothing is owed unless it comes back
};
// Sort order within a peer's block: what you owe, then what you are mid-thread
// on, then what you have already signed off.
const STATE_RANK: Record<MyState, number> = { awaiting: 0, commented: 1, approved: 2 };

// Where you stand, plus the PR itself. The url is what makes the ⎇ on a
// ready-for-review row clickable — the sc-id already goes to Shortcut, and the
// question you actually have on a review row is "show me the diff".
interface PrInfo {
  state: MyState;
  url?: string;
}

// ---- self-sizing ----
// tmux cannot do this for us. Its hooks are all command and lifecycle events
// (after-<command>, client-resized, pane-died); there is no content-changed
// event, and a layout is geometry that knows nothing about how many rows a
// program actually printed. The only thing that knows this pane needs seven rows
// rather than twelve is this pane, so it asks for them itself.
//
// Exactly ONE pane in a column may do this, or the two fight over every row. It
// is this one rather than the worktrees panel above because the arithmetic only
// works in this direction: whatever this pane does not claim, tmux hands to its
// sibling automatically. Peers shrinking IS worktrees growing, so the worktrees
// panel needs no resize logic at all and cannot end up arguing with this.
//
// The clamp is not defensive padding. `resize-pane -y` is bounded by the window,
// not by anything reasonable for the neighbour: asking for 40 rows in a 30-row
// window leaves the sibling at h=1. PEERS_MAX_ROWS is what reserves a floor for
// the worktrees panel, since this pane has no way to ask how many rows that one
// wants.
const AUTOSIZE = process.env.TERMDASH_NO_AUTOSIZE !== "1";
const PEERS_MIN_ROWS = 3; // an error line, or one peer with one ticket
const PEERS_MAX_ROWS = 14; // the rest of the column belongs to worktrees

// ---- summaries ----

const CACHE_DIR = path.join(os.homedir(), ".cache", "termdash");
const SUMMARY_CACHE = path.join(CACHE_DIR, "shortcut-summaries.json");
// Which link targets are finished. "Completed" is terminal, so a true here is
// good forever and the story is never fetched again; anything else is re-checked
// each poll because it can still move.
const LINK_DONE_CACHE = path.join(CACHE_DIR, "shortcut-link-done.json");
const SUMMARY_MAX = 24; // characters — 2-3 words, and the width budget below
const SUMMARY_TIMEOUT_MS = 120_000;
const SUMMARIES_ENABLED = process.env.TERMDASH_NO_LLM !== "1";

// ---- colors ----

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";
const YELLOW = "\x1b[33m";
// Plain ansi red rather than a 256-colour like SC_BLUE, so it resolves to
// color1 -- #ea6962 in kitty.conf -- and tracks the terminal palette instead of
// pinning a second, slightly-different red next to it.
const RED = "\x1b[31m";


function link(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + "…";
}

// ---- shortcut api ----

/** Shortcut's verbs are "blocks", "duplicates" and "relates to". */
interface ScStoryLink {
  verb: string;
  subject_id: number;
  object_id: number;
}

interface ScStory {
  id: number;
  name: string;
  archived: boolean;
  owner_ids: string[];
  updated_at: string;
  workflow_state_id: number;
  // Already in every /stories/search response -- this interface just never
  // named them. No extra request buys these.
  story_links?: ScStoryLink[];
  completed?: boolean;
}
interface ScMember {
  id: string;
  profile: { name: string; mention_name: string };
}

async function shortcut<T>(p: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SHORTCUT_API}${p}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Shortcut-Token": SHORTCUT_TOKEN as string,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`shortcut ${p} → ${res.status}`);
  return (await res.json()) as T;
}

async function resolveTeamAndStates(): Promise<{
  groupId: string;
  stateIds: number[];
  reviewStates: Set<number>;
}> {
  const groups = await shortcut<{ id: string; name: string; archived: boolean }[]>("/groups");
  const group = groups.find((g) => !g.archived && g.name === SC_TEAM_NAME);
  if (!group) throw new Error(`no Shortcut team "${SC_TEAM_NAME}"`);

  const workflows = await shortcut<{ states: { id: number; name: string }[] }[]>("/workflows");
  // Resolved by NAME at runtime, same as the team: state ids are per-workspace and
  // hardcoding them is how this breaks silently when someone renames a column.
  const reviewStates = new Set<number>();
  const stateIds: number[] = [];
  for (const w of workflows) {
    for (const st of w.states) {
      const match = SC_STATES.find((c) => c.name === st.name.trim());
      if (!match) continue;
      stateIds.push(st.id);
      if (match.review) reviewStates.add(st.id);
    }
  }
  if (!stateIds.length) throw new Error(`no Shortcut states ${SC_STATE_NAMES.join(", ")}`);
  return { groupId: group.id, stateIds, reviewStates };
}

// The search endpoint takes ONE workflow_state_id, so this is a request per state
// deduped by story id. archived is not optional: the UI hides archived stories,
// so a raw group+state search drags in long-dead tickets that are not in the
// column you are looking at. (Same shape as fetchReviews in morning-brief.ts.)
async function fetchActiveStories(groupId: string, stateIds: number[]): Promise<ScStory[]> {
  const perState = await Promise.all(
    stateIds.map((id) => shortcut<ScStory[]>("/stories/search", { group_id: groupId, workflow_state_id: id })),
  );
  const byId = new Map<number, ScStory>();
  for (const s of perState.flat()) if (!s.archived) byId.set(s.id, s);
  return [...byId.values()];
}

// ---- collisions: live work linked to work that is not finished ----
//
// RED here does NOT mean "blocked". Shortcut's `blocked` flag is 0 of 45 on this
// board -- the team does not use it -- so a red built on it would never render.
// It also would not be worth rendering: a blocked ticket is its owner's problem
// and you cannot act on it from this pane.
//
// What IS worth a colour is two efforts that need reconciling, because that is
// the question this pane exists to answer (see the header: "deciding whether the
// thing you are about to pick up is already someone's"). That shows up as a
// story_link whose other end has not shipped yet.
//
// The counterpart's state is the whole filter. Measured on this board: 15 linked
// pairs, 9 of them pointing at Completed tickets -- history, and lighting those
// would put ~20% of rows in red and bankrupt the colour. Excluding them leaves 3.
async function resolveCollisions(
  shown: ScStory[],
  active: Map<number, ScStory>,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!shown.length) return out;

  let done: Record<string, true> = {};
  try {
    done = JSON.parse(fs.readFileSync(LINK_DONE_CACHE, "utf8")) as Record<string, true>;
  } catch {
    done = {};
  }
  const before = Object.keys(done).length;

  for (const st of shown) {
    // Lowest id wins when a story has several qualifying links, so the row shows
    // the same counterpart on every poll rather than flickering between them.
    const targets = (st.story_links ?? [])
      .map((l) => (l.subject_id === st.id ? l.object_id : l.subject_id))
      .filter((id) => id !== st.id)
      .sort((a, b) => a - b);

    for (const id of targets) {
      if (done[String(id)]) continue;
      // Already on the board in a started state, so it cannot be finished and
      // costs no request to judge.
      if (active.has(id)) {
        out.set(st.id, id);
        break;
      }
      let target: ScStory | null = null;
      try {
        target = await shortcut<ScStory>(`/stories/${id}`);
      } catch {
        // Deleted, or in a workspace this token cannot read. Stay quiet rather
        // than lighting a row red over a story nobody can open.
        continue;
      }
      if (target?.completed) {
        done[String(id)] = true;
        continue;
      }
      out.set(st.id, id);
      break;
    }
  }

  if (Object.keys(done).length !== before) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(LINK_DONE_CACHE, JSON.stringify(done, null, 2));
    } catch {
      // A cache that will not persist is slower, not broken.
    }
  }
  return out;
}

// ---- one-time 2-3 word summaries, cached on disk ----

interface SummaryEntry {
  title: string; // title at generation time; a change invalidates the entry
  summary: string;
  at: string;
}

function loadSummaries(): Record<string, SummaryEntry> {
  try {
    return JSON.parse(fs.readFileSync(SUMMARY_CACHE, "utf8")) as Record<string, SummaryEntry>;
  } catch {
    return {};
  }
}

async function ensureSummaries(stories: ScStory[]): Promise<Map<number, string>> {
  const cache = loadSummaries();
  const out = new Map<number, string>();
  const missing: ScStory[] = [];

  for (const s of stories) {
    const hit = cache[s.id];
    if (hit && hit.title === s.name) out.set(s.id, hit.summary);
    else missing.push(s);
  }
  if (!missing.length || !SUMMARIES_ENABLED) return out;

  const prompt = [
    `Compress each Shortcut ticket title to 2-3 words naming WHAT is being worked on.`,
    ``,
    `Rules:`,
    `- 2-3 words. Hard limit ${SUMMARY_MAX} characters.`,
    `- Name the subject, never the verdict or the action verb. "sms scheduling guard",`,
    `  not "fix SMS bug" and not "do not create campaigns".`,
    `- Drop ticket-speak: bracketed priorities, "[P2]", numbering, the word "ticket".`,
    `- Lower case. No trailing period, no quotes, no emoji.`,
    ``,
    `Return ONLY a JSON object mapping id to summary, no prose and no code fence.`,
    ``,
    ...missing.map((s) => `${s.id} | ${s.name}`),
  ].join("\n");

  let raw: string;
  try {
    // cwd is a temp dir on purpose: run from this repo and the CLI loads the
    // project's settings and skills, which costs startup time and context for a
    // task that needs neither. (Lifted from morning-brief.ts.)
    raw = execFileSync("claude", ["-p", prompt], {
      encoding: "utf8",
      timeout: SUMMARY_TIMEOUT_MS,
      cwd: os.tmpdir(),
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    return out; // fall back to raw titles for the whole batch
  }

  let parsed: Record<string, string>;
  try {
    const m = raw.match(/\{[\s\S]*\}/); // tolerate a stray fence or preamble
    parsed = m ? (JSON.parse(m[0]) as Record<string, string>) : {};
  } catch {
    return out;
  }

  const now = new Date().toISOString();
  for (const s of missing) {
    const v = (parsed[String(s.id)] ?? "").trim();
    if (!v) continue;
    const clean = trunc(v, SUMMARY_MAX);
    out.set(s.id, clean);
    cache[s.id] = { title: s.name, summary: clean, at: now };
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(SUMMARY_CACHE, JSON.stringify(cache, null, 2));
  } catch {
    /* a cache we could not write just means we regenerate next time */
  }
  return out;
}

// ---- render ----

interface PeerBlock {
  name: string;
  stories: ScStory[];
  visible: number; // how many of `stories` fit — set by fitToBudget
}

// Hands out the pane's ticket rows across the peers who have work.
//
// Everyone starts at the ceiling, then rows are taken back from whoever is
// showing the most until the total fits. Trimming the LONGEST list first is what
// stops one person mid-sprint from pushing everyone else out of the pane — the
// question this pane answers is "what is the team on", which needs breadth before
// depth. Nobody is ever trimmed below one ticket: a name with no tickets under it
// tells you less than nothing.
//
// Stories are pre-sorted by your standing on them (see gather), so what is dropped
// is always the least urgent end of someone's list.
function fitToBudget(blocks: PeerBlock[]): void {
  for (const b of blocks) b.visible = Math.min(b.stories.length, MAX_TICKETS_PER_PEER);

  // One name row per peer is not negotiable; everything else is ticket rows.
  // Nothing is reserved for a header — this pane draws no title.
  const budget = PEERS_MAX_ROWS - blocks.length;
  let total = blocks.reduce((acc, b) => acc + b.visible, 0);
  while (total > budget) {
    const longest = blocks.reduce((m, b) => (b.visible > m.visible ? b : m), blocks[0]);
    if (longest.visible <= 1) break; // everyone is down to one; the pane is full
    longest.visible--;
    total--;
  }
}

function storyUrl(id: number): string {
  return `https://app.shortcut.com/${SC_SLUG}/story/${id}`;
}

// Builds the whole frame and writes it in ONE go with no trailing newline. Both
// halves of that matter. A trailing newline scrolls a full pane by a row, so
// printing N lines into the N-row pane selfSize just asked for pushes the first
// peer off the top — the same trap local-status.ts documents for its 1-row strip.
// And a single write means the pane repaints atomically instead of flickering
// line by line.
function render(
  blocks: PeerBlock[],
  summaries: Map<number, string>,
  myState: Map<number, PrInfo>,
  reviewStates: Set<number>,
  collisions: Map<number, number>,
  note?: string,
): void {
  const width = process.stdout.columns || 55;
  const lines: string[] = [];

  if (note) {
    lines.push(`${YELLOW}peers${RESET} ${DIM}${trunc(note, Math.max(4, width - 6))}${RESET}`);
  } else if (!blocks.length) {
    lines.push(`${DIM}no peer work in ${SC_STATE_NAMES.join(" / ")}${RESET}`);
  } else {
    for (const b of blocks) {
      const hidden = b.stories.length - b.visible;
      // The overflow count rides on the NAME line rather than taking a row of its
      // own — a "+2" that costs a row to say two rows are missing is a bad trade
      // in a pane this short.
      const tail = hidden > 0 ? `${DIM} +${hidden}${RESET}` : "";
      lines.push(`${BOLD}${trunc(b.name, Math.max(6, width - 4))}${RESET}${tail}`);

      for (const st of b.stories.slice(0, b.visible)) {
        const id = `sc-${st.id}`;
        const pr = myState.get(st.id);
        const reviewable = reviewStates.has(st.workflow_state_id);

        // Both slots are reserved on EVERY row, not just the rows that fill them,
        // so the summaries stay on one left edge. A glyph that shifts its
        // neighbours reads as a rendering fault rather than as a flag.
        const mark = pr ? `${STATE_GLYPH[pr.state]} ` : "   ";
        // ⎇ — same glyph the worktrees panel uses for "the PR on GitHub", and only
        // on a review row: everywhere else the diff is not the thing you want, and
        // a link on every row would make the one that matters invisible.
        // Colourised here rather than in the template so an empty slot emits a
        // plain space instead of a coloured one.
        const gh = reviewable && pr?.url ? `${SC_BLUE}${link("⎇", pr.url)}${RESET}` : " ";

        // The counterpart is the payload, not a decoration: a red row whose
        // partner you cannot name tells you something is wrong without telling
        // you what. It is almost always off-screen too -- the live targets sit
        // in Ready for Development and this pane only draws started work -- so
        // there is no second red row to pair with by eye.
        const hit = collisions.get(st.id);
        const tailText = hit ? ` ↔${hit}` : "";

        // Width budget: " ⎿ " + id + space + 1-col ⎇ slot + space + 3-col marker,
        // less the counterpart when there is one. Only colliding rows pay for it.
        const room = Math.max(6, width - 3 - id.length - 1 - 1 - 1 - 3 - tailText.length);
        const text = trunc(summaries.get(st.id) ?? st.name.toLowerCase(), Math.min(SUMMARY_MAX, room));

        // Red outranks blue. A row can be both yours to review and colliding,
        // and the collision is the one that needs a decision -- "reviewable" is
        // still carried by the blue ⎇ in the slot before it, so nothing is lost
        // by spending the id on the louder fact.
        const idColor = hit ? RED : reviewable ? SC_BLUE : GRAY;
        const tail = hit ? `${RED}${tailText}${RESET}` : "";
        lines.push(
          ` ${GRAY}⎿${RESET} ${link(`${idColor}${id}${RESET}`, storyUrl(st.id))} ${gh} ${mark}${text}${tail}`,
        );
      }
    }
  }

  process.stdout.write("\x1b[3J\x1b[2J\x1b[H" + lines.join("\n"));
}

// Rows this pane will actually print: a name line per peer plus its visible
// tickets. Counted from the same slice render() draws, so the two cannot drift.
function desiredRows(blocks: PeerBlock[]): number {
  const n = blocks.reduce((acc, b) => acc + 1 + b.visible, 0);
  return Math.min(PEERS_MAX_ROWS, Math.max(PEERS_MIN_ROWS, n || 1));
}

// Only fires when the number actually changes. A resize-pane per poll would
// repaint both panes in this column every five minutes to accomplish nothing,
// and it would stomp a manual drag every time.
let sizedTo = -1;

function selfSize(rows: number): void {
  if (!AUTOSIZE || !process.env.TMUX || !process.env.TMUX_PANE) return;
  if (rows === sizedTo) return;
  try {
    execFileSync("tmux", ["resize-pane", "-t", process.env.TMUX_PANE, "-y", String(rows)], {
      stdio: "ignore",
      timeout: 2_000,
    });
    sizedTo = rows;
  } catch {
    /* not under tmux, pane is gone, or the layout refused — draw anyway */
  }
}

// ---- your standing on each peer's PR ----

// Story ids whose open PR is waiting on your review. Never throws: this is a
// marker on an existing row, and the pane must draw without it rather than not
// draw at all. Same contract as the summaries.
async function fetchMyReviewState(): Promise<Map<number, PrInfo>> {
  const out = new Map<number, PrInfo>();
  if (!GITHUB_TOKEN) return out;

  // number is unused downstream but kept in the selection — it is what makes a
  // failed join debuggable with --once.
  const frag = `... on PullRequest { number url headRefName isDraft }`;
  // Same fragment plus my own reviews, for the one bucket that has to tell an
  // approval apart from a comment. Only that bucket pays for the sub-selection.
  const fragReviews = `... on PullRequest {
    number url headRefName isDraft
    reviews(first: 20, author: "${MY_LOGIN}") { nodes { state submittedAt } }
  }`;

  // Four searches, one round trip. The qualifiers do the classifying server-side
  // so nothing here has to page through the repo's ~150 open PRs:
  //   requested   — GitHub re-adds you to the request list when an author asks
  //                 again, so this IS "back on your plate", even post-approval.
  //   reviewed    — you filed something; the sub-selection says approval or not.
  //   commented   — you talked but never filed a review.
  //   untouched   — you have not been near it.
  //
  // first:100 is the API ceiling per search. `sort:updated-desc` is what makes the
  // ceiling safe: a PR in the team's review column was touched recently by
  // definition, so it cannot be pushed past position 100 by stale PRs.
  const base = `repo:${GH_REPO} is:pr is:open -author:${MY_LOGIN}`;
  const query = `query {
    requested: search(type: ISSUE, first: 50, query: "${base} review-requested:${MY_LOGIN}") { nodes { ${frag} } }
    reviewed: search(type: ISSUE, first: 100, query: "${base} reviewed-by:${MY_LOGIN} sort:updated-desc") { nodes { ${fragReviews} } }
    commented: search(type: ISSUE, first: 100, query: "${base} commenter:${MY_LOGIN} -reviewed-by:${MY_LOGIN} sort:updated-desc") { nodes { ${frag} } }
    untouched: search(type: ISSUE, first: 100, query: "${base} -reviewed-by:${MY_LOGIN} -commenter:${MY_LOGIN} sort:updated-desc") { nodes { ${frag} } }
  }`;

  type Node = {
    number?: number;
    url?: string;
    headRefName?: string;
    isDraft?: boolean;
    reviews?: { nodes: { state?: string; submittedAt?: string | null }[] };
  } | null;

  const storyOf = (n: NonNullable<Node>): number | null => {
    const m = n.headRefName?.match(/(?:^|\/)sc-(\d+)(?:\/|$)/);
    return m ? Number(m[1]) : null;
  };

  try {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `bearer ${GITHUB_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return out;
    const json = (await res.json()) as {
      data?: Record<string, { nodes: Node[] } | undefined>;
      errors?: unknown[];
    };
    if (json.errors?.length || !json.data) return out;

    // Applied LEAST urgent first so a more urgent verdict overwrites it. That
    // ordering is the whole precedence rule: a PR you approved and were then
    // re-requested on reads as "waiting on you", not as "done".
    const order: [string, MyState][] = [
      ["untouched", "awaiting"],
      ["commented", "commented"],
      ["reviewed", "reviewed"], // refined to approved/commented below
      ["requested", "awaiting"],
    ];

    for (const [alias, state] of order) {
      for (const n of json.data[alias]?.nodes ?? []) {
        if (!n || n.isDraft) continue; // a draft is not a review request
        const story = storyOf(n);
        if (story === null) continue;
        if (state !== "reviewed") {
          out.set(story, { state, url: n.url });
          continue;
        }
        // "I approved it" means my LATEST review is an approval — an old APPROVED
        // followed by a later CHANGES_REQUESTED is not one, and the reverse is the
        // ordinary re-review flow. Same rule the morning brief uses.
        const mine = (n.reviews?.nodes ?? [])
          .filter((r) => r.submittedAt)
          .sort((a, b) => (a.submittedAt! < b.submittedAt! ? -1 : 1));
        out.set(story, { state: mine.at(-1)?.state === "APPROVED" ? "approved" : "commented", url: n.url });
      }
    }
  } catch {
    /* offline, rate-limited, bad token, slow — the pane just loses the glyph */
  }
  return out;
}

// ---- gather ----

async function gather(): Promise<{
  blocks: PeerBlock[];
  summaries: Map<number, string>;
  myState: Map<number, PrInfo>;
  reviewStates: Set<number>;
  collisions: Map<number, number>;
  note?: string;
}> {
  if (!SHORTCUT_TOKEN)
    return {
      blocks: [],
      summaries: new Map(),
      myState: new Map(),
      reviewStates: new Set(),
      collisions: new Map(),
      note: "SHORTCUT_RO_TOKEN not set",
    };

  const members = await shortcut<ScMember[]>("/members");
  const byMention = new Map(members.map((m) => [m.profile.mention_name.toLowerCase(), m]));
  const peerIds = new Map<string, string>(); // member id → display name
  for (const mention of PEERS) {
    const m = byMention.get(mention.toLowerCase());
    if (m) peerIds.set(m.id, m.profile.name);
  }
  if (!peerIds.size)
    return {
      blocks: [],
      summaries: new Map(),
      myState: new Map(),
      reviewStates: new Set(),
      collisions: new Map(),
      note: "no PEERS matched a Shortcut member",
    };

  const { groupId, stateIds, reviewStates } = await resolveTeamAndStates();
  // Needed before the per-peer sort below, not just at render time, so it is
  // fetched alongside the stories rather than with the summaries.
  const [stories, myState] = await Promise.all([
    fetchActiveStories(groupId, stateIds),
    fetchMyReviewState(),
  ]);

  // A story with two owners is rendered under BOTH of them. That is not a bug to
  // dedupe away: the pane answers "what is this person on", and a ticket shared
  // by two people is genuinely on both their plates.
  const byPeer = new Map<string, ScStory[]>();
  for (const s of stories) {
    for (const o of s.owner_ids ?? []) {
      if (!peerIds.has(o)) continue;
      const list = byPeer.get(o) ?? [];
      list.push(s);
      byPeer.set(o, list);
    }
  }

  const blocks: PeerBlock[] = [];
  // PEERS order, not API order, so the pane does not reshuffle between polls.
  for (const mention of PEERS) {
    const m = byMention.get(mention.toLowerCase());
    if (!m) continue;
    // Sorted by where YOU stand on it — owed, then mid-thread, then signed off,
    // then everything you have no relationship with — and by recency inside that.
    // Two jobs: it puts the rows you have to act on at the top of each person's
    // block, and it means anything fitToBudget has to drop is the least urgent end
    // of the list, so a ticket waiting on you can never be the one behind a "+N".
    const rank = (id: number) => {
      const st = myState.get(id);
      return st ? STATE_RANK[st] : 3;
    };
    const list = (byPeer.get(m.id) ?? []).sort(
      (a, b) => rank(a.id) - rank(b.id) || b.updated_at.localeCompare(a.updated_at),
    );
    if (list.length) blocks.push({ name: m.profile.name, stories: list, visible: 0 });
  }

  // Budget first, then summarise — only what is actually about to be shown. The
  // overflow behind a "+N" costs nothing until it surfaces.
  fitToBudget(blocks);
  const shown = blocks.flatMap((b) => b.stories.slice(0, b.visible));
  // Same slice as the summaries, and for the same reason: a collision behind a
  // "+N" is not on screen to be reconciled, so it costs nothing until it is.
  const [summaries, collisions] = await Promise.all([
    ensureSummaries(shown),
    resolveCollisions(shown, new Map(stories.map((st) => [st.id, st]))),
  ]);
  return { blocks, summaries, myState, reviewStates, collisions };
}

// ---- --classify: re-derive PEERS (see the header) ----

async function classify(): Promise<void> {
  if (!SHORTCUT_TOKEN) throw new Error("SHORTCUT_RO_TOKEN not set");
  const members = await shortcut<ScMember[]>("/members");
  const groups = await shortcut<{ id: string; name: string; archived: boolean; member_ids: string[] }[]>("/groups");
  const group = groups.find((g) => !g.archived && g.name === SC_TEAM_NAME);
  if (!group) throw new Error(`no Shortcut team "${SC_TEAM_NAME}"`);

  // Wider net than the pane uses: a developer is judged on everything they have
  // shipped recently, not just what is open right now.
  const workflows = await shortcut<{ name: string; states: { id: number; name: string }[] }[]>("/workflows");
  const wanted = new Set([
    "In Development", "Ready for Review", "Ready for QA", "In QA",
    "Ready for Merge", "Ready for Deploy", "Completed",
  ]);
  const stateIds = workflows.flatMap((w) => w.states.filter((s) => wanted.has(s.name.trim())).map((s) => s.id));

  const seen = new Map<number, ScStory>();
  for (const id of stateIds) {
    for (const s of await shortcut<ScStory[]>("/stories/search", { group_id: group.id, workflow_state_id: id })) {
      if (!s.archived) seen.set(s.id, s);
    }
  }
  const recent = [...seen.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 90);
  process.stderr.write(`classifying against ${recent.length} recent stories…\n`);

  // Branches are absent from the search payload, so this needs a detail call per
  // story. This is the entire reason --classify is not the runtime path.
  const authored = new Map<string, number>();
  for (const s of recent) {
    const d = await shortcut<{ branches?: { name: string }[] }>(`/stories/${s.id}`);
    for (const b of d.branches ?? []) {
      const prefix = (b.name ?? "").split("/")[0].toLowerCase();
      if (prefix) authored.set(prefix, (authored.get(prefix) ?? 0) + 1);
    }
  }

  const me = await shortcut<{ id: string }>("/member");
  const rows = group.member_ids
    .map((id) => members.find((m) => m.id === id))
    .filter((m): m is ScMember => Boolean(m))
    .map((m) => ({
      m,
      n: authored.get(m.profile.mention_name.toLowerCase()) ?? 0,
      self: m.id === me.id,
    }))
    .sort((a, b) => b.n - a.n);

  console.log(`\n${"member".padEnd(22)}${"@mention".padEnd(18)}${"branches".padStart(9)}  verdict`);
  for (const r of rows) {
    // Two, not one: a single hit is as easily a revert branch or a one-off commit
    // to someone else's ticket as it is a developer.
    const dev = r.n >= 2;
    const verdict = r.self ? "you (excluded)" : dev ? "DEV" : "not a dev";
    console.log(
      `${r.m.profile.name.padEnd(22)}@${r.m.profile.mention_name.padEnd(17)}${String(r.n).padStart(9)}  ${verdict}`,
    );
  }
  const list = rows.filter((r) => r.n >= 2 && !r.self).map((r) => `"${r.m.profile.mention_name}"`);
  console.log(`\nPaste over PEERS:\n\nconst PEERS = [${list.join(", ")}];\n`);
}

// ---- entry point ----

// Last gathered state, kept so a resize can redraw at the new width immediately
// instead of showing rows truncated to the old one for up to POLL_MINUTES — and,
// more to the point, without spending a round of API calls on a window drag.
let last: {
  blocks: PeerBlock[];
  summaries: Map<number, string>;
  myState: Map<number, PrInfo>;
  reviewStates: Set<number>;
  note?: string;
} | null = null;

async function tick(): Promise<void> {
  try {
    last = await gather();
    // Size first, then draw: render() measures process.stdout.columns, and a
    // resize that lands after the paint would leave the frame justified to the
    // old geometry until the next poll.
    selfSize(last.note ? PEERS_MIN_ROWS : desiredRows(last.blocks));
    render(last.blocks, last.summaries, last.myState, last.reviewStates, last.collisions, last.note);
  } catch (err) {
    last = null;
    process.stdout.write("\x1b[3J\x1b[2J\x1b[H");
    console.log(`${YELLOW}peers${RESET} ${DIM}${(err as Error).message}${RESET}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--classify")) return classify();
  await tick();
  if (process.argv.includes("--once")) return;
  setInterval(tick, POLL_MINUTES * 60_000);
  process.stdout.on("resize", () => {
    if (last) render(last.blocks, last.summaries, last.myState, last.reviewStates, last.collisions, last.note);
  });
}

void main();
