/**
 * brief-html — the morning brief as a Chrome page.
 *
 * Pure layout. Every fetch, ranking and bucketing rule lives in morning-brief.ts,
 * which hands this file a finished BriefModel; nothing here decides what matters,
 * only where it goes. Output is ONE self-contained HTML file — inline CSS, a few
 * lines of inline JS, no network — because it is opened from file:// by
 * brief-open and must render the instant Chrome comes forward.
 *
 * LAYOUT, and why
 *   - Things waiting on YOU come first (reviews you owe, your PRs that need a
 *     move, Shortcut comments aimed at you). Those are the to-do list; everything
 *     below them is situational awareness.
 *   - The agenda is a sidebar, not a section. It frames the day rather than
 *     being a task in it, and it should stay visible while you work down the list.
 *   - Every row is one big link. The whole row is the target, not a 12px title.
 *   - An empty section costs exactly its heading, with the "nothing here" on the
 *     heading itself — the same rule the terminal brief follows.
 *   - Rows nobody needs to act on (PRs waiting on reviewers, backlog stories,
 *     Sentry issues already ticketed or self-healed) collapse into <details>.
 *     Counted, so a number that looks wrong is still noticeable.
 */

import type { MyPrRow, MyPrState, NotionTodoGroup, ScStoryRow, ScTalk } from "./morning-brief";

export interface BriefModel {
  generatedAt: string;
  windowStart: string;
  login: string;
  team: string;
  agenda: {
    note?: string;
    events: {
      title: string;
      start: string;
      end: string;
      all_day: boolean;
      in_progress: boolean;
      location: string | null;
      join_url: string | null;
    }[];
  };
  reviews: {
    note?: string;
    rows: {
      number: number;
      url: string;
      title: string;
      author: string;
      storyId: number;
      readyAt: string;
      requestedOfMe: boolean;
      needsLead: boolean;
      reReview: boolean;
      touchedByMe: boolean;
      approvedByOthers: boolean;
      interacted: boolean;
      effort: "low" | "medium" | "high" | null;
      createdAt: string;
      reviewCount: number;
      commentCount: number;
      additions: number;
      deletions: number;
      changedFiles: number;
      app: { additions: number; deletions: number; files: number; partial: boolean };
    }[];
  };
  myPrs: { note?: string; rows: MyPrRow[] };
  shortcut: { note?: string; talk: ScTalk[]; mine: ScStoryRow[]; fresh: ScStoryRow[] };
  notion: { note?: string; current: NotionTodoGroup | null; older: NotionTodoGroup[] };
  sentry: {
    note?: string;
    windowDays: number;
    novel: {
      tag: string;
      summary: string;
      explanation: string | null; // a few sentences, folded under the row
      title: string;
      disambiguator: string | null;
      shortId: string;
      url: string;
      count: number;
      users: number;
      unhandled: boolean;
      finalRetries: number;
      trend: string;
      trendDir: string;
      suggestedTeam: string | null;
      scId: string | null;
    }[];
    buckets: { glyph: string; label: string; count: number; events: number; detail: string; stories: string[] }[];
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SC_STORY = (id: number | string) => `https://app.shortcut.com/popmenu/story/${id}`;

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// "14:05" today, "Thu 4:12 PM" this week, "Oct 3" older. Absolute rather than
// "3h ago": the page is generated at 06:00 and read at 09:00, and a relative
// time baked into a static file is wrong by the time you read it.
function when(iso: string, now: Date): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) return clock(iso);
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 6) return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${clock(iso)}`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function ageDays(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Shortcut comment text is markdown with mentions as plain "@name". One line,
// no markup, bounded — it is a preview, the link is the full thing.
function preview(md: string, n = 220): string {
  const flat = md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[image]")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function tag(text: string, tone: string): string {
  return `<span class="tag ${tone}">${esc(text)}</span>`;
}

/**
 * The "+ To-do" button that parks a row on the Notion list.
 *
 * A LINK, not a fetch. This page is one self-contained file:// document with
 * no network (see the header) — it cannot POST to Notion, CORS forbids it
 * from a file:// origin, and carrying NOTION_TOKEN would put a secret in
 * ~/.cache/termdash/today.html. `termdash-todo:` is owned by
 * TermDashToDo.app (build-todo-app.sh), which runs todo-add.sh, which calls
 * `notion-todo.ts --add` — the same append the interactive pane uses, so the
 * week-rollover rule has one implementation.
 *
 * The text is baked in HERE, at generation time, so the button carries a
 * sentence written while the row's data was still in hand. Nothing is
 * computed at click time; the URL is the whole payload.
 */
/**
 * What a row's to-do should SAY, per kind of thing.
 *
 * Written at page-generation time, while the row's data is still in hand —
 * the button carries a finished sentence, not an id to look up later. Each
 * reads as an instruction to future-you with enough context to act on
 * without opening the brief again, which is the whole point: by the time you
 * read the Notion list, this page is gone.
 *
 * Titles are truncated rather than wrapped. A to-do list is scanned, and a
 * PR title can run to 120 characters.
 */
function todoFor(kind: "pr" | "review" | "story" | "sentry", x: {
  title: string;
  ref?: string | number;
}): string {
  const title = x.title.length > 80 ? `${x.title.slice(0, 79)}…` : x.title;
  switch (kind) {
    case "review":
      return `Review PR #${x.ref} — "${title}"`;
    case "pr":
      return `Move PR #${x.ref} along — "${title}"`;
    case "story":
      return `sc-${x.ref} — update ticket`;
    case "sentry":
      return `Triage Sentry: ${title}`;
  }
}

function todoLink(text: string): string {
  return `<a class="todo" href="termdash-todo://add?text=${encodeURIComponent(text)}" title="${esc(text)}">+ To-do</a>`;
}

/**
 * A row, optionally with its to-do button beside it.
 *
 * The button CANNOT live inside the row: a row is one big `<a>` (see the
 * layout note at the top), and an `<a>` inside an `<a>` is invalid HTML —
 * browsers close the outer one early and the click lands on the wrong
 * target. So the pair is wrapped, and the row keeps flex: 1.
 */
function row(href: string, badge: string, title: string, meta: string, todo?: string): string {
  const link = `<a class="row" href="${esc(href)}">${badge}<span class="body"><span class="title">${title}</span>${
    meta ? `<span class="meta">${meta}</span>` : ""
  }</span></a>`;
  return todo ? `<div class="rowwrap">${link}${todoLink(todo)}</div>` : link;
}

// Heading with the count, or with the empty/skipped state riding on it.
function section(id: string, icon: string, name: string, opts: { note?: string; empty?: string; count?: number }, body: string): string {
  let status = "";
  if (opts.note) status = `<span class="status warn">skipped — ${esc(opts.note)}</span>`;
  else if (opts.empty) status = `<span class="status">${esc(opts.empty)}</span>`;
  else if (opts.count) status = `<span class="count">${opts.count}</span>`;
  const quiet = opts.note || opts.empty ? " quiet" : "";
  return `<section id="${id}" class="${quiet.trim()}"><h2><span class="icon">${icon}</span>${esc(name)}${status}</h2>${
    opts.note || opts.empty ? "" : body
  }</section>`;
}

function fold(summary: string, body: string): string {
  return body ? `<details><summary>${summary}</summary>${body}</details>` : "";
}

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

// "3d", "5h", "40m": how long the PR has existed. Baked in at generation time,
// which is fine at this granularity.
function age(iso: string, now: Date): string {
  const mins = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.round(mins)}m`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

// Only the age text is coloured, not the card: over 24h yellow, over 48h red.
function ageTone(iso: string, now: Date): string {
  const hours = (now.getTime() - new Date(iso).getTime()) / 3_600_000;
  return hours > 48 ? "age-red" : hours > 24 ? "age-yellow" : "";
}

const EFFORT_TAG: Record<string, [string, string]> = {
  low: ["LOW", "green"],
  medium: ["MEDIUM", "yellow"],
  high: ["HIGH", "red"],
};

type ReviewCard = BriefModel["reviews"]["rows"][number];

function diff(label: string, hint: string, add: number, del: number, files: number, partial: boolean): string {
  const ge = partial ? "≥" : "";
  return `<span class="diff" title="${esc(hint)}"><span class="dim">${esc(label)}</span> <span class="${add ? "add" : "dim"}">${ge}+${add}</span> <span class="${del ? "del" : "dim"}">${ge}−${del}</span> <span class="dim">· ${ge}${plural(files, "file")}</span></span>`;
}

function reviewCard(x: ReviewCard, now: Date): string {
  const [label, tone] = x.effort ? EFFORT_TAG[x.effort] : ["UNRATED", "gray"];
  const flags = [
    x.needsLead ? `<span class="lead">👔 needs a lead reviewer</span>` : "",
    x.reReview ? `<span class="advice">re-review requested</span>` : "",
    !x.reReview && x.interacted ? "you've commented" : "",
    !x.interacted && x.requestedOfMe ? "requested of you" : "",
    x.approvedByOthers ? "approved by others" : "",
  ].filter(Boolean);
  const stats =
    `<span class="stats">` +
    `<span title="submitted reviews">✅ ${plural(x.reviewCount, "review")}</span>` +
    `<span title="conversation + review-thread comments">💬 ${plural(x.commentCount, "comment")}</span>` +
    `<span class="${ageTone(x.createdAt, now)}" title="age of the PR">⏱ ${age(x.createdAt, now)} old</span>` +
    diff("diff", "every changed line", x.additions, x.deletions, x.changedFiles, false) +
    diff("app code", "excluding tests, specs, fixtures, docs, lockfiles and generated files", x.app.additions, x.app.deletions, x.app.files, x.app.partial) +
    `</span>`;
  const meta = [`<b>${esc(x.author)}</b>`, `ready ${esc(when(x.readyAt, now))}`, ...flags, `<span class="ref">sc-${x.storyId}</span>`];
  // Wrapped by hand rather than through `row()`: a review card builds its own
  // anchor so it can carry the stats block.
  const card = `<a class="row card" href="${esc(x.url)}">${tag(label, tone)}<span class="body"><span class="title">${esc(x.title)} <span class="ref">#${x.number}</span></span><span class="meta">${meta.join(" · ")}</span>${stats}</span></a>`;
  return `<div class="rowwrap">${card}${todoLink(todoFor("review", { title: x.title, ref: x.number }))}</div>`;
}

// Split by whether you have been on the PR before. The two halves ask different
// things of you: a fresh read versus picking a thread back up.
function reviewsSection(m: BriefModel, now: Date): string {
  const r = m.reviews;
  // Waiting on a lead goes first, on its own (morning-brief.ts LEAD_REVIEW_TEAM):
  // it blocks the merge and only a lead can clear it.
  const lead = r.rows.filter((x) => x.needsLead);
  const fresh = r.rows.filter((x) => !x.needsLead && !x.interacted);
  const been = r.rows.filter((x) => !x.needsLead && x.interacted);
  const group = (title: string, rows: ReviewCard[]) =>
    rows.length
      ? `<h4>${esc(title)} <span class="dim">${rows.length}</span></h4>${rows.map((x) => reviewCard(x, now)).join("")}`
      : `<h4>${esc(title)} <span class="dim">none</span></h4>`;
  return section(
    "reviews",
    "🤝",
    "Reviews you owe",
    { note: r.note, empty: r.rows.length ? undefined : "nothing waiting on you", count: r.rows.length },
    (lead.length ? group("👔 Needs a lead reviewer", lead) : "") +
      group("New to you", fresh) +
      group("You've been here", been),
  );
}

const PR_STATE: Record<MyPrState, [string, string]> = {
  "ci-failing": ["CI RED", "red"],
  changes: ["CHANGES", "orange"],
  conflict: ["CONFLICT", "yellow"],
  "to-qa": ["TO QA", "yellow"],
  ready: ["MERGE IT", "green"],
  qa: ["IN QA", "blue"],
  waiting: ["WAITING", "gray"],
  draft: ["DRAFT", "gray"],
};

// States where the next move is someone else's: QA, reviewers, or you-later.
const IDLE_PR: MyPrState[] = ["qa", "waiting", "draft"];

function myPrsSection(m: BriefModel, now: Date): string {
  const p = m.myPrs;
  const prRow = (x: MyPrRow) => {
    const [label, tone] = PR_STATE[x.state];
    const meta = [
      x.repo === "Popmenu/popmenu" ? "" : esc(x.repo),
      x.approvals ? `${plural(x.approvals, "approval")}` : "",
      x.state === "waiting" && x.ci === "PENDING" ? "CI running" : "",
      x.state === "to-qa" ? `<span class="hot">needs QA — move sc-${x.storyId} to Ready for QA</span>` : "",
      x.storyState && x.state !== "to-qa" ? `<span class="ref">sc-${x.storyId}</span> ${esc(x.storyState)}` : "",
      x.qaApp ? "QA app up" : "",
      x.state === "ready" && x.noQa ? "no QA required" : "",
      `updated ${esc(when(x.updatedAt, now))}`,
    ].filter(Boolean);
    return row(x.url, tag(label, tone), `${esc(x.title)} <span class="ref">#${x.number}</span>`, meta.join(" · "));
  };
  const act = p.rows.filter((x) => !IDLE_PR.includes(x.state));
  const idle = p.rows.filter((x) => IDLE_PR.includes(x.state));
  const inQa = idle.filter((x) => x.state === "qa").length;
  const waiting = idle.filter((x) => x.state === "waiting").length;
  const drafts = idle.filter((x) => x.state === "draft").length;
  const idleLabel = [inQa ? `${inQa} in QA` : "", waiting ? `${waiting} waiting on reviewers` : "", drafts ? plural(drafts, "draft") : ""]
    .filter(Boolean)
    .join(" · ");

  const body = act.map(prRow).join("") + fold(esc(idleLabel), idle.map(prRow).join(""));
  return section(
    "prs",
    "🚀",
    "Your PRs",
    {
      note: p.note,
      empty: p.rows.length ? undefined : "none open",
      count: act.length || undefined,
    },
    body,
  );
}

function talkSection(m: BriefModel, now: Date): string {
  const s = m.shortcut;
  const rows = s.talk
    .map((t) =>
      row(
        t.url,
        t.mention ? tag("@YOU", "blue") : tag("ON YOURS", "gray"),
        `${esc(t.storyName)} <span class="ref">sc-${t.storyId}</span>`,
        `<b>${esc(t.author)}</b> · ${esc(when(t.createdAt, now))} — ${esc(preview(t.text))}`,
      ),
    )
    .join("");
  return section(
    "talk",
    "💬",
    "Talking to you in Shortcut",
    { note: s.note, empty: s.talk.length ? undefined : "no new comments for you", count: s.talk.length },
    rows,
  );
}

// Workflow state names are written for a column header, not an 84px tag.
// "Ready for Development" wrapped onto two lines and pushed the row taller than
// its neighbours.
function shortState(s: string): string {
  return s.replace(/Development/i, "Dev").replace(/^Ready for /i, "Ready: ").toUpperCase();
}

// Where the story is in the delivery flow, by colour: blue = being built,
// yellow = with reviewers or QA, purple = ready to merge, grey = not started.
function stateTone(state: string): string {
  const s = state.toLowerCase();
  if (/^in dev/.test(s)) return "blue";
  if (/ready for review|ready for qa|^in qa/.test(s)) return "yellow";
  if (/ready for merge/.test(s)) return "magenta";
  return "gray";
}

function storyRow(x: ScStoryRow, now: Date, showOwners: boolean, pr?: MyPrRow): string {
  const status = x.blocked ? tag("BLOCKED", "red") : tag(shortState(x.state), stateTone(x.state));
  // The open PR for this story, if you have one, under the status badge: the
  // story says where the ticket is, the PR says what is holding it.
  const badge = pr
    ? `<span class="badges">${status}${tag(`PR ${PR_STATE[pr.state][0]}`, PR_STATE[pr.state][1])}</span>`
    : status;
  const meta = [
    x.type === "bug" ? "🐞 bug" : x.type === "chore" ? "chore" : "",
    x.estimate == null ? `<span class="hot">no estimate</span>` : `${x.estimate} pt`,
    pr ? `<span class="ref">PR #${pr.number}</span>` : "",
    showOwners ? (x.owners.length ? esc(x.owners.join(", ")) : `<span class="hot">unowned</span>`) : "",
    showOwners ? `created ${esc(when(x.createdAt, now))}` : `updated ${esc(when(x.updatedAt, now))}`,
  ].filter(Boolean);
  const stale = !showOwners && ageDays(x.updatedAt, now) > 30;
  return row(
    x.url,
    badge,
    `${esc(x.name)} <span class="ref">sc-${x.id}</span>`,
    meta.join(" · "),
    todoFor("story", { title: x.name, ref: x.id }),
  ).replace(
    'class="row"',
    `class="row${stale ? " stale" : ""}"`,
  );
}

// Unfinished to-dos from the Notion weekly list. This week's in full; every
// older week's leftovers folded into one line, because the page carries ~90 of
// them going back to February and most are no longer live.
function notionSection(m: BriefModel): string {
  const n = m.notion;
  const item = (t: { text: string; url: string }) =>
    `<a class="todoitem" href="${esc(t.url)}"><span class="box">☐</span><span>${esc(t.text)}</span></a>`;
  const cur = n.current?.items ?? [];
  const olderCount = n.older.reduce((k, g) => k + g.items.length, 0);
  const older = n.older
    .map((g) => `<h4>week of ${esc(g.heading)} <span class="dim">${g.items.length}</span></h4>${g.items.map(item).join("")}`)
    .join("");
  const empty = !cur.length && !olderCount ? "all done" : undefined;
  return section(
    "notion",
    "📝",
    n.current ? `To-dos · week of ${n.current.heading}` : "To-dos",
    { note: n.note, empty, count: cur.length || undefined },
    (cur.length ? cur.map(item).join("") : `<p class="todoempty">nothing left this week</p>`) +
      fold(`${plural(olderCount, "unfinished item")} from earlier weeks`, older),
  );
}

function freshSection(m: BriefModel, now: Date): string {
  const s = m.shortcut;
  return section(
    "fresh",
    "🆕",
    `New on the ${m.team} board`,
    { note: s.note, empty: s.fresh.length ? undefined : "nothing new since yesterday", count: s.fresh.length },
    s.fresh.map((x) => storyRow(x, now, true)).join(""),
  );
}

function mineSection(m: BriefModel, now: Date): string {
  const s = m.shortcut;
  // Joined on the sc-id in your PR's branch name -- see fetchMyPrs.
  const prOf = new Map(m.myPrs.rows.filter((p) => p.storyId).map((p) => [p.storyId as number, p]));
  const active = s.mine.filter((x) => x.stateType === "started" || x.blocked);
  const rest = s.mine.filter((x) => !(x.stateType === "started" || x.blocked));
  return section(
    "mine",
    "📋",
    "Your stories",
    { note: s.note, empty: s.mine.length ? undefined : "nothing assigned", count: active.length || undefined },
    active.map((x) => storyRow(x, now, false, prOf.get(x.id))).join("") +
      fold(
        `${plural(rest.length, "story", "stories")} not started`,
        rest.map((x) => storyRow(x, now, false, prOf.get(x.id))).join(""),
      ),
  );
}

function sentrySection(m: BriefModel): string {
  const s = m.sentry;
  const tone: Record<string, string> = { REGRESS: "magenta", NEW: "yellow", SPIKE: "orange" };
  const rows = s.novel
    .map((x) => {
      const meta = [
        `<span class="ref">${esc(x.shortId)}</span>`,
        `${x.count}× in 24h${x.users ? ` · ${plural(x.users, "user")}` : ""}`,
        `<span class="trend ${x.trendDir}">${esc(x.trend)}</span>`,
        x.unhandled ? "unhandled" : "",
        x.finalRetries ? `<span class="hot">⛔ ${x.finalRetries} exhausted retries — that work is gone</span>` : "",
        x.suggestedTeam ? `<span class="advice">↩ ${esc(x.suggestedTeam)}? (check with /sentry-assignment)</span>` : "",
        x.scId ? `<span class="ref">sc-${esc(x.scId)}</span>` : "",
      ].filter(Boolean);
      const title = `${esc(x.summary)}${x.disambiguator ? ` <span class="dim">· ${esc(x.disambiguator)}</span>` : ""}`;
      const r = row(x.url, x.tag ? tag(x.tag, tone[x.tag]) : tag("FIRING", "gray"), title, meta.join(" · ")).replace(
        '<a class="row"',
        `<a class="row" title="${esc(x.title)}"`,
      );
      // A sibling of the row, not inside it: the row is an <a>, and a click on
      // the fold has to open the fold, not Sentry.
      return x.explanation
        ? r + `<details class="explain"><summary>what is this?</summary><p>${esc(x.explanation)}</p></details>`
        : r;
    })
    .join("");

  const buckets = s.buckets
    .map((b) => {
      const stories = b.stories.map((id) => `<a class="ref" href="${SC_STORY(id)}">sc-${esc(id)}</a>`).join(" ");
      return `<div class="bucket"><span class="glyph">${esc(b.glyph)}</span><b>${esc(b.label)}</b> ${b.count} · ${
        b.events
      } events${b.detail ? ` · ${esc(b.detail)}` : ""}${stories ? ` · ${stories}` : ""}</div>`;
    })
    .join("");

  const nothing = !s.novel.length && !s.buckets.length;
  return section(
    "sentry",
    "🔥",
    `Sentry — ${m.team}`,
    { note: s.note, empty: nothing ? "nothing the team owns fired in 24h" : undefined, count: s.novel.length || undefined },
    rows +
      (buckets ? `<div class="buckets">${s.novel.length ? "" : `<p class="dim">nothing new — the rest is accounted for:</p>`}${buckets}</div>` : ""),
  );
}

function agendaAside(m: BriefModel, now: Date): string {
  const a = m.agenda;
  if (a.note) return `<aside><h2><span class="icon">📅</span>Meetings</h2><p class="status warn">skipped — ${esc(a.note)}</p></aside>`;
  const allDay = a.events.filter((e) => e.all_day);
  const timed = a.events.filter((e) => !e.all_day).sort((x, y) => (x.start < y.start ? -1 : 1));

  const items: string[] = [];
  for (const e of allDay) items.push(`<li class="allday">${esc(e.title)}</li>`);

  // The gaps are drawn in because "four meetings" and "four meetings, all
  // before 1pm" are different days. Only gaps of 30m+ — anything shorter is a
  // bathroom break, not time you can do anything with.
  let prevEnd: string | null = null;
  for (const e of timed) {
    if (prevEnd) {
      const gap = (new Date(e.start).getTime() - new Date(prevEnd).getTime()) / 60_000;
      if (gap >= 30) {
        const h = Math.floor(gap / 60);
        const mm = Math.round(gap % 60);
        items.push(`<li class="gap">${h ? `${h}h` : ""}${mm ? `${mm}m` : ""} free</li>`);
      }
    }
    const join = e.join_url ? ` <a class="join" href="${esc(e.join_url)}">join</a>` : "";
    items.push(
      `<li class="event" data-start="${esc(e.start)}" data-end="${esc(e.end)}"><span class="time">${esc(clock(e.start))}</span><span class="what">${esc(
        e.title,
      )}${join}</span></li>`,
    );
    if (!prevEnd || e.end > prevEnd) prevEnd = e.end;
  }

  const booked = timed.reduce((n, e) => n + (new Date(e.end).getTime() - new Date(e.start).getTime()) / 60_000, 0);
  const summary = timed.length ? `${plural(timed.length, "meeting")} · ${Math.round((booked / 60) * 10) / 10}h booked` : "clear";
  void now;
  return `<aside><h2><span class="icon">📅</span>Meetings<span class="status">${esc(summary)}</span></h2><ul class="agenda">${items.join(
    "",
  )}</ul></aside>`;
}

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------

export function renderHtml(m: BriefModel): string {
  const now = new Date(m.generatedAt);
  const start = new Date(m.windowStart);
  const day = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const since = `${start.toLocaleDateString("en-US", { weekday: "short" })} ${clock(m.windowStart)}`;

  // The to-do count: things that need a move from you today. Not the sum of
  // every row on the page — informational rows do not belong in a number that
  // says "this many things need you".
  const prsToAct = m.myPrs.rows.filter((x) => !IDLE_PR.includes(x.state)).length;
  const chips: [string, string, number][] = [
    ["reviews", "reviews", m.reviews.rows.length],
    ["prs", prsToAct === 1 ? "PR to move" : "PRs to move", prsToAct],
    ["talk", "comments", m.shortcut.talk.length],
    ["sentry", "new in Sentry", m.sentry.novel.length],
    ["fresh", "new stories", m.shortcut.fresh.length],
  ];
  const todo = m.reviews.rows.length + prsToAct + m.shortcut.talk.length + m.sentry.novel.length;
  const chipHtml = chips
    .filter(([, , n]) => n > 0)
    .map(([id, label, n]) => `<a class="chip" href="#${id}"><b>${n}</b> ${esc(label)}</a>`)
    .join("");

  // Three columns. Centre: the reviews you owe, the one queue that is purely
  // other people waiting on you. Left: your own things (meetings, stories, PRs).
  // Right: what arrived from others (comments, Sentry, new team stories).
  const needs = [reviewsSection(m, now), myPrsSection(m, now)].join("\n");
  const today = [agendaAside(m, now), notionSection(m), mineSection(m, now)].join("\n");
  const watch = [talkSection(m, now), sentrySection(m), freshSection(m, now)].join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${todo ? `(${todo}) ` : ""}Morning brief · ${esc(now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }))}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>☀️</text></svg>">
<style>${CSS}</style>
</head><body data-generated="${esc(m.generatedAt)}">
<div id="stale" hidden></div>
<header>
  <h1>${esc(day)}</h1>
  <p class="sub">since ${esc(since)} · generated ${esc(clock(m.generatedAt))}</p>
  <nav>${chipHtml || `<span class="status">nothing needs you this morning ☕</span>`}</nav>
</header>
<div class="layout">
  <div class="col needs"><h3>Needs you</h3>${needs}</div>
  <div class="col watch"><h3>Incoming</h3>${watch}</div>
  <div class="col today"><h3>Yours</h3>${today}</div>
</div>
<footer>${esc(m.login)} · regenerate: <code>~/Code/term-dash/morning-brief.ts --html</code>, then reload</footer>
<script>${JS}</script>
</body></html>
`;
}

// A static page stays open in a tab for days. This is the only thing that
// would make it lie, so it is the only thing the script does: say when the page
// is not today's, and mark the meeting that is on now.
const JS = `
(() => {
  const gen = new Date(document.body.dataset.generated);
  const now = new Date();
  if (gen.toDateString() !== now.toDateString()) {
    const el = document.getElementById("stale");
    el.hidden = false;
    el.textContent = "This is " + gen.toLocaleDateString("en-US", { weekday: "long" }) + "'s brief — today's has not been generated yet.";
  }
  for (const li of document.querySelectorAll("li.event")) {
    const s = new Date(li.dataset.start), e = new Date(li.dataset.end);
    if (now >= e) li.classList.add("past");
    else if (now >= s) li.classList.add("now");
  }
})();
`;

const CSS = `
/* Dark only, by preference -- not tied to the system appearance. */
:root {
  --bg: #161618; --card: #1f1f22; --fg: #ececec; --dim: #9a9aa0; --line: #2e2e33; --hover: #29292d;
  --red: #ef5350; --orange: #ff9a3c; --yellow: #e6c14a; --green: #66bb6a; --blue: #64b5f6; --magenta: #ce93d8; --gray: #8a8a8e;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; }
a { color: inherit; text-decoration: none; }
#stale { background: var(--yellow); color: #000; padding: 10px 32px; font-weight: 600; }
/* The header sits over the centre column, which is where your eye goes first. */
header { max-width: 820px; margin: 0 auto; padding: 32px 0 8px; text-align: center; }
h1 { margin: 0; font-size: 30px; letter-spacing: -0.02em; }
.sub { margin: 2px 0 14px; color: var(--dim); }
nav { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.chip { padding: 6px 12px; border-radius: 999px; background: var(--card); border: 1px solid var(--line); }
.chip:hover { background: var(--hover); }
/* "Needs you" is a fixed-width column in the exact centre of the window.
   Meetings (left) and "keep an eye on" (right) are equal 1fr tracks, so they
   grow and shrink together and the centre column stays centred at any width. */
.layout {
  padding: 16px 32px 32px; display: grid; gap: 24px; align-items: start;
  grid-template-columns: minmax(260px, 1fr) minmax(0, 820px) minmax(260px, 1fr);
  grid-template-areas: "today needs watch";
}
.needs { grid-area: needs; } .watch { grid-area: watch; } .today { grid-area: today; }
.col h3 { margin: 0 0 10px 4px; font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim); }
/* Two columns: "needs you" left with meetings under it, "keep an eye on" right.
   Row 2 is 1fr so the tall right column's height lands there, not as a gap
   between "needs you" and the meetings. */
@media (max-width: 1500px) {
  .layout {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: auto 1fr;
    grid-template-areas: "needs watch" "today watch";
  }
}
@media (max-width: 960px) {
  .layout { grid-template-columns: 1fr; grid-template-rows: none; grid-template-areas: "today" "needs" "watch"; }
}
section, aside { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 6px 0 8px; margin-bottom: 18px; }
section.quiet { background: transparent; padding: 0; }
section.quiet h2 { padding: 4px 4px; color: var(--dim); }
h2 { display: flex; align-items: baseline; gap: 8px; margin: 0; padding: 10px 18px 6px; font-size: 15px; font-weight: 650; }
h2 .icon { width: 1.4em; }
.count { background: var(--fg); color: var(--card); border-radius: 999px; padding: 0 8px; font-size: 12px; font-weight: 700; }
.status { color: var(--dim); font-weight: 400; font-size: 14px; }
.status.warn { color: var(--orange); }
.row { display: flex; gap: 12px; align-items: baseline; padding: 9px 18px; border-top: 1px solid var(--line); min-height: 44px; }
.row:hover { background: var(--hover); }
/* The row and its to-do button are siblings, not nested - see row() in this
   file. The wrapper owns the border the row used to draw, so the button sits
   inside the same ruled band instead of below it.
   NO BACKTICKS IN HERE: this CSS is inside a template literal, and one ends
   the string. */
.rowwrap { display: flex; align-items: stretch; border-top: 1px solid var(--line); }
.rowwrap .row { flex: 1; min-width: 0; border-top: none; }
.rowwrap:hover { background: var(--hover); }
/* Deliberately large: this is a one-click "deal with it later", reached in a
   hurry, and a 12px target is not that. Full row height, fixed width so the
   buttons line up into a column you can run down. */
.todo {
  flex: 0 0 92px; display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
  color: var(--muted); border-left: 1px solid var(--line);
  text-decoration: none; white-space: nowrap;
}
.todo:hover { background: var(--accent, #2d6cdf); color: #fff; }
/* Confirmation without a round trip: the page is static and cannot know
   whether Notion took it, so the click itself is what acknowledges. */
.todo:active { transform: scale(0.97); }
.row.stale { opacity: 0.6; }
/* Review cards: effort tag on the left like every other row; the title,
   details and stats are centred in the rest of the card. */
.badges { flex: none; display: flex; flex-direction: column; gap: 4px; }
.todoitem { display: flex; gap: 10px; padding: 7px 18px; border-top: 1px solid var(--line); font-size: 14px; }
.todoitem:hover { background: var(--hover); }
.todoitem .box { color: var(--dim); flex: none; }
.todoempty { margin: 0; padding: 8px 18px; border-top: 1px solid var(--line); color: var(--dim); font-size: 14px; }
.card { padding: 14px 24px 14px 18px; align-items: center; }
.card .body { flex: 1; align-items: center; text-align: center; }
.card .stats { justify-content: center; }
.diff { font-variant-numeric: tabular-nums; }
.age-yellow { color: var(--yellow); font-weight: 600; } .age-red { color: var(--red); font-weight: 600; }
.add { color: var(--green); font-weight: 600; } .del { color: var(--red); font-weight: 600; }
.card .title { font-size: 15.5px; }
.stats { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 4px; font-size: 13px; }
h4 { margin: 0; padding: 12px 18px 6px; text-align: center; border-top: 1px solid var(--line); font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--dim); }
.body { display: flex; flex-direction: column; min-width: 0; }
.title { font-weight: 500; overflow-wrap: anywhere; }
.meta { color: var(--dim); font-size: 13px; }
.meta b { color: var(--fg); font-weight: 600; }
.ref { color: var(--dim); font: 12px ui-monospace, "SF Mono", Menlo, monospace; }
a.ref:hover { text-decoration: underline; }
.dim { color: var(--dim); }
.hot { color: var(--red); }
.advice { color: var(--yellow); }
.lead { color: var(--red); font-weight: 600; }
.trend.up { color: var(--orange); } .trend.down { color: var(--green); }
.tag { flex: none; width: 84px; text-align: center; font: 700 10.5px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.04em; padding: 4px 0; border-radius: 4px; border: 1px solid currentColor; position: relative; top: -1px; }
.tag.red { color: var(--red); } .tag.orange { color: var(--orange); } .tag.yellow { color: var(--yellow); } .tag.green { color: var(--green); }
.tag.blue { color: var(--blue); } .tag.magenta { color: var(--magenta); } .tag.gray { color: var(--gray); }
details { border-top: 1px solid var(--line); }
summary { cursor: pointer; padding: 9px 18px; color: var(--dim); font-size: 14px; }
/* Sentry "what is this?" — indented to sit under the title, past the 84px tag. */
details.explain { border-top: none; }
details.explain summary { padding: 0 18px 8px 114px; margin-top: -4px; font-size: 12.5px; }
details.explain p { margin: 0; padding: 0 18px 10px 114px; font-size: 13.5px; line-height: 1.45; }
summary:hover { color: var(--fg); }
.buckets { border-top: 1px solid var(--line); padding: 8px 18px 2px; color: var(--dim); font-size: 13.5px; }
.buckets p { margin: 0 0 4px; }
.bucket { padding: 2px 0; }
.bucket .glyph { display: inline-block; width: 1.6em; }
.bucket b { color: var(--fg); font-weight: 500; }
ul.agenda { list-style: none; margin: 0; padding: 0 0 4px; }
.agenda li { padding: 7px 18px; border-top: 1px solid var(--line); display: flex; gap: 10px; }
.agenda .time { flex: none; width: 70px; white-space: nowrap; color: var(--dim); font-variant-numeric: tabular-nums; }
.agenda .gap { color: var(--green); font-size: 13px; padding: 4px 18px 4px 98px; }
.agenda .allday { color: var(--dim); font-size: 13px; }
.agenda .past { opacity: 0.45; }
.agenda .now { background: var(--hover); box-shadow: inset 3px 0 var(--blue); font-weight: 600; }
.join { color: var(--blue); font-size: 13px; margin-left: 4px; }
footer { max-width: 820px; margin: 0 auto; padding: 0 0 40px; text-align: center; color: var(--dim); font-size: 12.5px; }
code { font: 12px ui-monospace, "SF Mono", Menlo, monospace; }
`;
