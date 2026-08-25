#!/usr/bin/env -S npx tsx
/**
 * herdr-flatten-spaces — one-shot migration from nested worktree Spaces to
 * top-level ones.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 * A Space created with `herdr worktree open` carries worktree metadata, and
 * Herdr groups every Space sharing a repo under one collapsible repo row. Nine
 * worktrees therefore rendered as ONE "popmenu" entry with nine ├─ children.
 * The grouping is not configurable — there is no flat mode in
 * `herdr --default-config`, and the membership is keyed on repo_root inside the
 * binary. A Space created with `workspace create --cwd` has no worktree
 * metadata and is top-level.
 *
 * herdr-sync now creates Spaces the second way, so NEW worktrees are already
 * flat. This script converts the ones that already exist.
 *
 * ── What it does to each nested Space ────────────────────────────────────────
 *   1. create a replacement Space at the same cwd, labelled with the directory
 *   2. move every pane across with `pane move --new-tab --workspace <new>`
 *   3. close the replacement's own empty root pane
 *   4. close the old Space
 *
 * Panes are MOVED, not recreated, so a Claude session or dev server running in
 * one keeps running — it lands in a new tab in the new Space. What does not
 * survive is the old Space's tab layout: each moved pane becomes its own tab,
 * because `pane move` can only place a pane into a new tab of another
 * workspace. Splits inside a tab have to be rebuilt by hand.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   ./herdr-flatten-spaces.ts            show the plan, change nothing
 *   ./herdr-flatten-spaces.ts --apply    do it
 *
 * Dry run is the default deliberately: this moves live processes around.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);
const HERDR = path.join(os.homedir(), ".local/bin/herdr");
const APPLY = process.argv.includes("--apply");

async function herdr<T>(args: string[]): Promise<T | undefined> {
  const { stdout } = await execFileP(HERDR, args, { maxBuffer: 8 << 20 });
  if (stdout.trim() === "") return undefined;
  const parsed = JSON.parse(stdout);
  if (parsed?.error) throw new Error(JSON.stringify(parsed.error));
  return parsed.result as T;
}

function log(msg: string): void {
  console.log(`${APPLY ? "" : "[dry-run] "}${msg}`);
}

interface Ws {
  workspace_id: string;
  label: string;
  worktree?: { checkout_path: string; is_linked_worktree: boolean };
}

async function main(): Promise<void> {
  const res = await herdr<{ workspaces?: Ws[] }>(["workspace", "list"]);
  const all = res?.workspaces ?? [];

  // Only LINKED worktrees. The repo's own checkout is the group's head row and
  // converting it would just make a tenth top-level Space for master, which is
  // not what the nesting complaint was about.
  const nested = all.filter((w) => w.worktree?.is_linked_worktree);

  if (nested.length === 0) {
    log("nothing to flatten — no Space carries linked-worktree metadata");
    return;
  }

  log(`${nested.length} nested Space(s) to flatten`);

  for (const w of nested) {
    const cwd = w.worktree!.checkout_path;
    const label = path.basename(cwd);

    const panes =
      (await herdr<{ panes?: { pane_id: string }[] }>(["pane", "list", "--workspace", w.workspace_id]))
        ?.panes ?? [];

    log(`  ${w.workspace_id} "${w.label}" → new Space "${label}" (${panes.length} pane(s) to move)`);
    if (!APPLY) continue;

    let created: string;
    let rootPane: string | undefined;
    try {
      const made = await herdr<any>([
        "workspace", "create", "--cwd", cwd, "--label", label, "--no-focus",
      ]);
      created = made?.workspace?.workspace_id;
      rootPane = made?.root_pane?.pane_id;
      if (!created) throw new Error("no workspace_id in response");
    } catch (err) {
      log(`    FAILED to create replacement: ${(err as Error).message} — leaving ${w.workspace_id} alone`);
      continue;
    }

    // Move panes one at a time. A failure here is the dangerous case: the old
    // Space still holds the pane, so stop touching this Space rather than
    // closing it and taking the process with it.
    let moved = 0;
    let failed = false;
    for (const p of panes) {
      try {
        await herdr(["pane", "move", p.pane_id, "--new-tab", "--workspace", created, "--no-focus"]);
        moved++;
      } catch (err) {
        log(`    FAILED to move ${p.pane_id}: ${(err as Error).message}`);
        failed = true;
        break;
      }
    }

    if (failed) {
      log(`    moved ${moved}/${panes.length}; NOT closing ${w.workspace_id}. Finish by hand.`);
      continue;
    }

    // The replacement's own root pane is an empty shell nobody asked for. Close
    // it only once something else is in the Space, or the Space closes with it.
    if (rootPane && moved > 0) {
      try {
        await herdr(["pane", "close", rootPane]);
      } catch {
        log(`    could not close the spare root pane ${rootPane} — harmless, close it yourself`);
      }
    }

    try {
      await herdr(["workspace", "close", w.workspace_id]);
      log(`    ${w.workspace_id} → ${created} (${moved} pane(s) moved)`);
    } catch (err) {
      log(`    moved everything but could not close ${w.workspace_id}: ${(err as Error).message}`);
    }
  }

  if (!APPLY) {
    console.log("");
    console.log("Nothing was changed. Re-run with --apply to do it.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
