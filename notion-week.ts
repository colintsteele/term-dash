#!/usr/bin/env -S npx tsx
/**
 * notion-week — which M/D heading a new to-do belongs under.
 *
 * The to-do page is a list of toggleable `heading_1` blocks labelled M/D
 * ("10/26"), each holding that week's `to_do` children. Adding an item has
 * always appended under the LAST such heading, whatever date it carried, so
 * a to-do added three weeks later still landed under the old week.
 *
 * WHAT THE PAGE ACTUALLY LOOKS LIKE, because it is not a clean weekly log and
 * the rules below are chosen around that. Recent headings:
 *
 *   8/9 Sun · 8/24 Mon · 8/31 Mon · 8/7 Fri · 9/20 Sun · 9/28 Mon ·
 *   10/19 Mon · 10/26 Mon
 *
 * Mostly Mondays, but Sundays and a Friday too; gaps of three weeks; and 8/7
 * sits AFTER 8/31, so the list is not even sorted. These were written whenever
 * something got written down, not on a schedule. So:
 *
 *   - A NEW heading is always the Monday of the current week. The old ones
 *     stay whatever they are; nothing is rewritten.
 *   - "Same week" is Monday-to-Sunday containing the heading's date, which
 *     makes a Sunday heading cover the week that ENDS on it. That is the
 *     reading that keeps 9/20 (Sun) and 9/28 (Mon) as different weeks, which
 *     they plainly were.
 *   - Skipped weeks are never backfilled. The page shows weeks you wrote in,
 *     and inventing empty ones would add blocks you never asked for.
 *
 * Pure and dependency-free so it can be exercised without touching Notion:
 *   ./notion-week.ts --self-test
 */

/** Midnight, local — the comparisons below are date-only and a stray time
 * component makes "same week" wrong for a few hours either side. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** The Monday on or before `d`. Sunday belongs to the week that is ENDING,
 * i.e. the Monday six days back, not the next one — JS makes Sunday 0, which
 * is the off-by-one this exists to contain. */
export function mondayOf(d: Date): Date {
  const day = startOfDay(d);
  const offset = (day.getDay() + 6) % 7; // Mon=0 … Sun=6
  day.setDate(day.getDate() - offset);
  return day;
}

/** "11/2" — no leading zeros, matching what is already on the page. */
export function weekLabel(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * A heading's date. The page writes M/D with no year, so the year is inferred
 * from `today`: the same year normally, the previous one when that would put
 * the heading far in the future — which is what a December heading read in
 * January is. Six months is the threshold because a to-do page is current;
 * anything further ahead is last year's entry, not a plan.
 *
 * Tolerates the stray space in "2 /30", which is really on the page.
 */
export function parseWeekHeading(text: string, today: Date): Date | null {
  const m = /^(\d{1,2})\s*\/\s*(\d{1,2})/.exec(text.trim());
  if (!m) return null;
  const month = Number(m[1]);
  const dayOfMonth = Number(m[2]);
  if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null;

  let candidate = new Date(today.getFullYear(), month - 1, dayOfMonth);
  // Round-trip check: Feb 30 normalises to March, and a heading that does not
  // survive the round trip is not a date we should be reasoning about.
  if (candidate.getMonth() !== month - 1) return null;

  const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;
  if (candidate.getTime() - startOfDay(today).getTime() > SIX_MONTHS_MS) {
    candidate = new Date(today.getFullYear() - 1, month - 1, dayOfMonth);
  }
  return candidate;
}

/** Do these two dates fall in the same Monday-to-Sunday week? */
export function isSameWeek(a: Date, b: Date): boolean {
  return mondayOf(a).getTime() === mondayOf(b).getTime();
}

/**
 * Does a to-do added `today` need a heading the page does not have yet?
 *
 * `lastHeadingText` is the text of the last M/D heading, or null when the page
 * has none. A page with no heading at all needs one — that is the only case
 * where this is true without a date comparison.
 */
export function needsNewWeek(
  lastHeadingText: string | null,
  today: Date,
): boolean {
  if (lastHeadingText === null) return true;
  const last = parseWeekHeading(lastHeadingText, today);
  if (last === null) return true;
  return !isSameWeek(last, today);
}

// ── self-test ───────────────────────────────────────────────────────────────
// Inline rather than a framework: this repo has no test runner and every file
// in it is a standalone `npx tsx` script, so a --self-test flag is the shape
// that fits. Exits non-zero on failure so it can gate a commit.
if (process.argv[2] === "--self-test") {
  let failures = 0;
  const check = (name: string, got: unknown, want: unknown) => {
    // String() so a null expectation reads as "null" rather than throwing,
    // and so a crash in one case does not abandon the rest of the run.
    const ok = String(got) === String(want);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got ${got}, want ${want}`}`);
  };
  const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

  check("monday of a Monday is itself", weekLabel(mondayOf(d(2026, 11, 2))), "11/2");
  check("monday of a Saturday", weekLabel(mondayOf(d(2026, 11, 7))), "11/2");
  // The Sunday case is the whole reason mondayOf exists in this form.
  check("Sunday belongs to the week ENDING on it", weekLabel(mondayOf(d(2026, 11, 8))), "11/2");
  check("next Monday rolls over", weekLabel(mondayOf(d(2026, 11, 9))), "11/9");

  check("label has no leading zeros", weekLabel(d(2026, 2, 3)), "2/3");

  check("parses a plain heading", weekLabel(parseWeekHeading("10/26", d(2026, 11, 7))!), "10/26");
  // "2 /30" is really on the page, stray space and all — and February has no
  // 30th, so it is a typo, not a date. Rejected rather than silently read as
  // March 2: a heading that is not a date must not be treated as this week's.
  check("the stray space is tolerated", weekLabel(parseWeekHeading("2 /23", d(2026, 11, 7))!), "2/23");
  check("but Feb 30 is not a date, so it is rejected", parseWeekHeading("2 /30", d(2026, 11, 7)), "null");
  check("rejects non-dates", parseWeekHeading("Backlog", d(2026, 11, 7)), "null");
  check(
    "a December heading read in January is last year",
    parseWeekHeading("12/28", d(2026, 1, 5))!.getFullYear(),
    2025,
  );
  check(
    "a January heading read in January is this year",
    parseWeekHeading("1/5", d(2026, 1, 5))!.getFullYear(),
    2026,
  );

  check("same week, Mon and Sat", isSameWeek(d(2026, 11, 2), d(2026, 11, 7)), true);
  check("different weeks across a Sunday", isSameWeek(d(2026, 11, 8), d(2026, 11, 9)), false);

  check("no heading at all needs one", needsNewWeek(null, d(2026, 11, 7)), true);
  check("unparseable heading needs one", needsNewWeek("Backlog", d(2026, 11, 7)), true);
  check("last week's heading needs a new one", needsNewWeek("10/26", d(2026, 11, 7)), true);
  check("this week's heading does not", needsNewWeek("11/2", d(2026, 11, 7)), false);
  // The real page skips weeks; one new heading, never a backfill.
  check("a three-week gap still makes exactly one", needsNewWeek("8/31", d(2026, 9, 20)), true);

  console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
