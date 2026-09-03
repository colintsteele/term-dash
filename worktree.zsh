#!/usr/bin/env zsh
#
# worktree.zsh — the `worktree` shell command that drives the term-dash
# worktree-per-task flow. Extracted verbatim from ~/.zsh-sources/functions.zsh
# so it can live alongside the dashboard and be shared with the team.
#
# THIS IS ZSH, NOT BASH. It relies on zsh-only features (`${x:h}`/`${x:t}`
# modifiers, `(f)`/`(N)`/`<1->` glob qualifiers, `${(@)arr[2,-1]}`, `read -q`,
# `read "var?prompt"`). Don't rename it to .sh or run it with bash.
#
# INSTALL: source it from your ~/.zshrc (it defines functions, doesn't run):
#     source ~/Code/term-dash/worktree.zsh
#
# DEPENDENCIES:
#   git                  (required)
#   gh                   (required for `worktree clean`; optional for `rm` — used
#                         only to report merged/unmerged in the confirmation)
#   bundle / yarn        (optional — auto-installs deps if a Gemfile/package.json
#                         is present; safe no-op otherwise)
#
# Note: the provisioning steps (husky symlink, .env / .bundle/config copy,
# docs/plans symlinks, bundle/yarn install) are tailored to the popmenu repo but
# are all guarded by existence checks, so they simply skip in other repos.

# Create/attach a git worktree in a sibling <repo>-worktrees/ dir and cd into it.
#   worktree -b steele/migrate-shortcut   # new branch off origin's default branch
#                                         #   (master, for popmenu), re-resolved
#                                         #   from the remote and freshly fetched;
#                                         #   aborts rather than fork off a stale base
#   worktree steele/migrate-shortcut      # existing (local or remote) branch
#   worktree clean [-y]                   # remove ALL worktrees whose PR has merged
#   worktree rm                           # remove the worktree you're IN (merged or
#                                         #   not; type "delete" to confirm)
# Worktree dir is named after the branch's last segment (steele/foo -> foo).
worktree() {
  if [[ "$1" == "clean" ]]; then shift; _worktree_clean "$@"; return $?; fi
  if [[ "$1" == "rm" || "$1" == "remove" ]]; then shift; _worktree_rm "$@"; return $?; fi
  if [[ "$1" == "install" ]]; then shift; _worktree_install "$@"; return $?; fi
  # --no-install splits creation into its fast half (checkout + provisioning,
  # seconds) and its slow half (node pin + bundle + yarn, minutes). Herdr's
  # prefix+shift+N binding uses it so the popup can close as soon as the
  # checkout exists, then run `worktree install` in the new Space's own zsh
  # pane where the output is visible and nothing is modal. Order-independent,
  # so `-b foo --no-install` and `--no-install -b foo` both work.
  local create=0 install=1 branch
  while (( $# )); do
    case "$1" in
      -b)          create=1; branch="$2"; shift 2 ;;
      --no-install) install=0; shift ;;
      *)           branch="$1"; shift ;;
    esac
  done
  if [[ -z "$branch" ]]; then
    echo "usage: worktree [-b] [--no-install] <branch>" >&2
    return 1
  fi

  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "worktree: not inside a git repository" >&2
    return 1
  }

  # Worktrees live in a SIBLING dir (<repo>-worktrees/), not nested inside the
  # repo. A nested worktree path is also inside the main checkout's workspace
  # root, so Cursor can't tell which window owns a file and opens diff/file
  # links in the wrong (main-repo) window. A sibling path belongs to exactly one
  # workspace, so links resolve to the worktree editor. (popmenu -> popmenu-worktrees)
  local dir="${root:h}/${root:t}-worktrees/${branch##*/}"
  if [[ -e "$dir" ]]; then
    echo "worktree: $dir already exists" >&2
    return 1
  fi
  mkdir -p "${dir:h}" # git worktree add won't create missing parent dirs

  # A new branch is only as current as the last fetch, so a FAILED fetch is not a
  # cosmetic problem — it silently forks you off whatever master looked like the
  # last time this machine was online, and you find out at rebase time. It used to
  # be `2>/dev/null` with no status check, which hid exactly that.
  #
  # Hard error for -b, warning otherwise: creating a branch is the case where the
  # base commit matters, whereas checking out an existing branch you already have
  # locally is a reasonable thing to do on a plane.
  if ! git -C "$root" fetch --quiet origin; then
    if (( create )); then
      echo "worktree: git fetch failed — refusing to branch off a possibly stale base" >&2
      return 1
    fi
    echo "worktree: git fetch failed — continuing with local refs" >&2
  fi

  if (( create )); then
    # refs/remotes/origin/HEAD is a LOCAL pointer written once at clone time. If
    # the repo's default branch is ever renamed it keeps naming the old one
    # indefinitely, and every new branch would quietly fork from a branch nobody
    # merges into any more. --auto re-reads it from the remote, so the answer is
    # the remote's, not this clone's memory of it. Side benefit: it repairs the
    # ref for every other tool that reads it.
    git -C "$root" remote set-head origin --auto >/dev/null 2>&1

    local base
    base=$(git -C "$root" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) \
      || base=$(git -C "$root" ls-remote --symref origin HEAD 2>/dev/null \
                | sed -n 's#^ref: refs/heads/\(.*\)\tHEAD$#origin/\1#p')
    # Last resort. Only reached with no origin/HEAD and no network; naming the
    # guess out loud beats forking off something unexpected in silence.
    if [[ -z "$base" ]]; then
      base="origin/master"
      echo "worktree: could not resolve origin's default branch, assuming $base" >&2
    fi

    # `worktree add` would report this itself, but its error names the ref without
    # explaining that the ref is the thing this function chose for you.
    if ! git -C "$root" rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
      echo "worktree: base ref '$base' does not exist locally — try: git -C $root fetch origin" >&2
      return 1
    fi

    # Print the base, and the commit. "Make sure it branches off master" is only
    # believable if you can see which master it used.
    echo "worktree: branching $branch off $base ($(git -C "$root" log -1 --format='%h %s' "$base" | cut -c1-72))"
    git -C "$root" worktree add -b "$branch" "$dir" "$base" || return 1
  else
    git -C "$root" worktree add "$dir" "$branch" || return 1
  fi

  # Husky's generated .husky/_ dir is gitignored, so it never lands in a fresh
  # worktree and the pre-commit hook dies sourcing _/husky.sh. Symlink it back to
  # the main repo's copy; since _ is already ignored, the link stays out of git.
  if [[ -d "$root/.husky/_" && -d "$dir/.husky" ]]; then
    ln -sfn "$root/.husky/_" "$dir/.husky/_"
  fi

  # ---- provision the fresh worktree ----
  # env files are gitignored, so a new worktree has none — copy them over from
  # the main checkout ((N) = nullglob, so a missing .env is a no-op, not an error).
  local envf copied=0
  for envf in "$root"/.env(N) "$root"/.env.*(N); do
    cp -p "$envf" "$dir/" && copied=1
  done
  (( copied )) && echo "worktree: copied env file(s) from main checkout"

  # Bundler auth for private gem sources (graphql.pro, contribsys, github pkg)
  # lives in the gitignored .bundle/config, so a fresh worktree can't
  # authenticate and `bundle install` fails. Copy it over — it also carries the
  # native-build flags (icu, odbc) those gems need.
  if [[ -f "$root/.bundle/config" ]]; then
    mkdir -p "$dir/.bundle"
    cp -p "$root/.bundle/config" "$dir/.bundle/config"
  fi

  # The slow half. Skipped by --no-install, which leaves a complete, usable
  # checkout that simply has no node_modules/gems yet — run `worktree install`
  # in it to finish.
  (( install )) && _worktree_install "$dir" "$root"

  # Share the planning docs. docs/plans is a tracked dir (docs/plans/.keep) whose
  # contents are gitignored and live only in the main checkout — so symlink each
  # entry (not the dir itself, which would orphan the tracked .keep and dirty the
  # worktree) into the worktree's docs/plans. Edits flow back to the one real
  # copy; links are gitignored so git never sees them. Reflects plans that exist
  # at creation time — rerun this block to pick up ones added to main later.
  if [[ -d "$root/docs/plans" && -d "$dir/docs/plans" ]]; then
    local plan
    for plan in "$root"/docs/plans/*(N); do
      ln -sfn "$plan" "$dir/docs/plans/${plan:t}"
    done
    echo "worktree: linked docs/plans from main checkout"
  fi

  # Share the SQL scratch dir, same reasoning as docs/plans: the queries you run
  # against the DB aren't per-branch, so ONE real copy lives in a sibling
  # <repo>-sql/ dir (popmenu -> ~/Code/popmenu-sql, matching the <repo>-worktrees
  # convention) and every worktree gets a symlink to it. Edit a query in any
  # worktree and it's the same file everywhere — no copying between trees, and
  # nothing stranded in a worktree you later delete.
  #
  # Symlink the DIR here rather than each file inside it (unlike docs/plans, which
  # links entries individually to avoid orphaning a tracked .keep): nothing under
  # sql/ is tracked, so there's no .keep to protect, and linking the dir itself
  # means queries added later show up without re-running this.
  #
  # Kept out of git via .git/info/exclude (`/sql`) rather than .gitignore: that file
  # lives in the shared common dir, so ONE line covers the main checkout and every
  # linked worktree, and the repo's own .gitignore stays untouched.
  #
  # Guarded on the dir existing, so it no-ops for repos without one (term-dash etc.).
  local sqldir="${root:h}/${root:t}-sql"
  if [[ -d "$sqldir" ]]; then
    ln -sfn "$sqldir" "$dir/sql"
    echo "worktree: linked shared sql/ -> ${sqldir/#$HOME/~}"
  fi

  cd "$dir"
}

# Install a worktree's dependencies: the slow half of `worktree -b`.
#   worktree install              # the worktree you're in
#   worktree install <dir>        # a specific one
#   _worktree_install <dir> <main-checkout>
#
# Split out of the create path so `worktree -b --no-install` can hand this to a
# terminal you can actually watch. Herdr's prefix+shift+N does exactly that: the
# popup returns as soon as the checkout is provisioned, and this runs in the new
# Space's zsh pane. Also useful on its own after a `yarn.lock` change or when a
# create-time install failed.
#
# Idempotent, and non-fatal throughout: a failed install still leaves a usable
# checkout with the error on screen to rerun by hand. Repos without a
# Gemfile/package.json simply skip.
#
# MUST run in an interactive shell that has loaded nvm.sh — _worktree_node_version
# is a no-op otherwise (nvm is a shell function, not a binary), and yarn would
# then compile native modules against whatever node happens to be active.
_worktree_install() {
  local dir="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
  if [[ -z "$dir" || ! -d "$dir" ]]; then
    echo "worktree install: not inside a git worktree (and no dir given)" >&2
    return 1
  fi

  # The main checkout, for the .nvmrc fallback. --git-common-dir points at the
  # ONE real .git dir shared by every linked worktree, so its parent is the main
  # checkout no matter which worktree we were called from. `git rev-parse
  # --show-toplevel` would just hand back $dir again.
  local fallback="${2}"
  if [[ -z "$fallback" ]]; then
    local common
    common=$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
    [[ -n "$common" ]] && fallback="${common:h}"
  fi

  _worktree_node_version "$dir" "$fallback"

  if [[ -f "$dir/Gemfile" ]] && command -v bundle >/dev/null; then
    echo "worktree: bundle install…"
    ( cd "$dir" && bundle install )
  fi
  if [[ -f "$dir/package.json" ]] && command -v yarn >/dev/null; then
    echo "worktree: yarn install…"
    ( cd "$dir" && yarn install )
  fi
}

# Switch nvm to the node version the repo pins, so the worktree's yarn install (and
# your shell afterward) runs on the same node the main checkout does.
#   _worktree_node_version <worktree-dir> <main-checkout-dir>
# The version comes from the repo, never hardcoded: .nvmrc / .node-version /
# .tool-versions, checked in the worktree first and falling back to the main
# checkout (popmenu tracks .nvmrc, so a fresh worktree already has it — the
# fallback covers repos that gitignore it). No version file, no nvm => no-op.
#
# nvm is a shell FUNCTION, not a binary, so `command -v nvm` is useless here and
# this only works because worktree.zsh is sourced into an interactive shell that
# already loaded nvm.sh. If nvm isn't loaded we stay silent and let the install run
# on whatever node is active — same behavior as before this existed.
_worktree_node_version() {
  local dir="$1" fallback="$2" file ver

  (( ${+functions[nvm]} )) || return 0

  for file in "$dir"/.nvmrc "$dir"/.node-version "$fallback"/.nvmrc "$fallback"/.node-version; do
    [[ -f "$file" ]] || continue
    ver=$(<"$file")
    break
  done
  # .tool-versions (asdf/mise) as a last resort: "nodejs 24.14.0" -> 24.14.0
  if [[ -z "$ver" ]]; then
    for file in "$dir"/.tool-versions "$fallback"/.tool-versions; do
      [[ -f "$file" ]] || continue
      # -E, not BRE: BSD/macOS sed has no \| alternation.
      ver=$(sed -nE 's/^(nodejs|node)[[:space:]]+([^[:space:]]+).*/\2/p' "$file" | head -1)
      [[ -n "$ver" ]] && break
    done
  fi

  ver="${ver//[[:space:]]/}"   # strip the trailing newline (and any stray spaces)
  [[ -n "$ver" ]] || return 0

  # `nvm use` fails when that exact version isn't installed yet — install it rather
  # than silently falling through to the default node. Non-fatal either way.
  if ! nvm use "$ver" >/dev/null 2>&1; then
    echo "worktree: node $ver (${file:t}) isn't installed — nvm install $ver…"
    nvm install "$ver" >/dev/null 2>&1 || {
      echo "worktree: nvm install $ver failed — continuing on node $(node -v 2>/dev/null)" >&2
      return 1
    }
  fi
  echo "worktree: node $(node -v) (pinned by ${file:t})"
}

# worktree clean — remove worktrees whose branch has a MERGED GitHub PR. Uses gh
# rather than `git branch --merged` because squash-merges (our default) leave the
# branch tip off master, so --merged never sees them. Safe by default: lists the
# candidates and asks once; pass -y to skip the prompt. Never touches the main
# checkout, and skips any worktree with uncommitted changes (worktree remove
# refuses without --force). Deletes the now-merged local branch too.
_worktree_clean() {
  local yes=0
  [[ "$1" == "-y" || "$1" == "--yes" ]] && yes=1

  command -v gh >/dev/null 2>&1 || {
    echo "worktree clean: needs the gh CLI (brew install gh)" >&2; return 1
  }

  # All worktree paths, main first. sed keeps the whole path (spaces-safe).
  local -a wt_paths
  wt_paths=( ${(f)"$(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')"} )
  (( ${#wt_paths} )) || { echo "worktree clean: not inside a git repository" >&2; return 1; }
  local main="${wt_paths[1]}"

  local -a rm_paths rm_branches
  local path branch merged
  for path in "${(@)wt_paths[2,-1]}"; do
    branch=$(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null) || continue
    [[ -z "$branch" ]] && continue   # detached HEAD — leave it alone
    merged=$( builtin cd "$main" && gh pr list --head "$branch" --state merged --json number --jq 'length' 2>/dev/null )
    [[ "$merged" == <1-> ]] && { rm_paths+=("$path"); rm_branches+=("$branch"); }
  done

  if (( ${#rm_paths} == 0 )); then
    echo "worktree clean: nothing merged to remove"; return 0
  fi

  echo "worktree clean: merged worktrees to remove:"
  local i
  for (( i = 1; i <= ${#rm_paths}; i++ )); do
    printf '  %s  (%s)\n' "${rm_paths[i]}" "${rm_branches[i]}"
  done

  if (( ! yes )); then
    read -q "REPLY?Remove ${#rm_paths} worktree(s)? [y/N] " || { echo; return 1; }
    echo
  fi

  for (( i = 1; i <= ${#rm_paths}; i++ )); do
    if git -C "$main" worktree remove "${rm_paths[i]}" 2>/dev/null; then
      git -C "$main" branch -D "${rm_branches[i]}" >/dev/null 2>&1
      echo "removed ${rm_branches[i]}"
    else
      echo "skipped ${rm_branches[i]} — uncommitted changes; force with: git -C '$main' worktree remove --force '${rm_paths[i]}'" >&2
    fi
  done
  git -C "$main" worktree prune
}

# worktree rm — remove the worktree you're STANDING IN, merged or not. Where
# `worktree clean` bulk-reaps only merged worktrees, this force-removes the current
# one, so it can drop unmerged commits / uncommitted work. Because that's
# destructive it demands you type the word "delete" (not a one-key y/N). Refuses to
# touch the main checkout. Moves your shell to the main checkout afterward, since
# the directory you were standing in no longer exists. Auto-deletes the branch when
# it's already merged; KEEPS it when it isn't (so commits aren't orphaned) and
# prints how to drop it by hand. In the popmenu repo it also runs
# `rake migrate_branch_down` first, so this branch's migrations are rolled back
# out of the shared dev DB and don't dirty the next worktree's models/schema.
_worktree_rm() {
  local wt_root
  wt_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "worktree rm: not inside a git repository" >&2; return 1
  }

  # Main working tree is the first entry of `git worktree list`.
  local main
  main=$(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -1)
  [[ -n "$main" ]] || { echo "worktree rm: could not determine the main checkout" >&2; return 1; }
  if [[ "$wt_root" == "$main" ]]; then
    echo "worktree rm: refusing to remove the main checkout ($main)." >&2
    echo "  cd into a linked worktree first." >&2
    return 1
  fi

  local branch
  branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null)

  # merged? best-effort (needs gh + a PR) — informational only; we remove either way.
  local merged=0 merged_note="unknown (gh unavailable)"
  if [[ -n "$branch" ]] && command -v gh >/dev/null 2>&1; then
    local n
    n=$(gh pr list --head "$branch" --state merged --json number --jq 'length' 2>/dev/null)
    if [[ "$n" == <1-> ]]; then merged=1; merged_note="yes"; else merged_note="NO — this removes unmerged work"; fi
  fi

  local dirty_note="clean"
  [[ -n "$(git status --porcelain 2>/dev/null)" ]] && dirty_note="DIRTY — uncommitted changes will be lost"

  echo "About to remove this worktree:"
  echo "  path:   $wt_root"
  echo "  branch: ${branch:-(detached HEAD)}"
  echo "  merged: $merged_note"
  echo "  state:  $dirty_note"
  echo

  local reply
  read "reply?Type 'delete' to remove this worktree: "
  if [[ "$reply" != "delete" ]]; then
    echo "worktree rm: aborted."
    return 1
  fi

  # Hand the shared dev DB back to master state before we drop the tree. Every
  # worktree copies the same .env, so they all share ONE Postgres dev DB: any
  # migration you ran on this branch is still applied there and would re-dirty
  # the NEXT worktree's models + db/schema.rb (annotaterb re-annotates against
  # the live DB on every db:* task, and app/models/salesforce/* is the loudest).
  # `rake migrate_branch_down` rolls back only THIS branch's own migrations (its
  # diff vs master), runs the downs with ANNOTATERB_SKIP_ON_DB_TASKS=1, then
  # re-annotates back to master. Guarded on the task file so it no-ops outside
  # popmenu. Best-effort: an irreversible/failed down shouldn't block removal,
  # so we warn and press on. Runs here (still cd'd in the worktree, after you
  # confirmed) so the branch + db/migrate/* files it inspects still exist. NOT
  # done in `worktree clean` — those branches are merged, so their migrations
  # belong to master and must stay applied.
  if [[ -n "$branch" && -f "$wt_root/lib/tasks/migrate_branch_down.rake" ]]; then
    echo "worktree rm: rolling back this branch's migrations (rake migrate_branch_down)…"
    if [[ -x "$wt_root/bin/rails" ]]; then
      ( builtin cd "$wt_root" && bin/rails migrate_branch_down )
    else
      ( builtin cd "$wt_root" && bundle exec rake migrate_branch_down )
    fi || echo "worktree rm: migrate_branch_down failed — the dev DB may still carry this branch's migrations (fix by hand); removing the worktree anyway." >&2
  fi

  # Step out before nuking the dir, or the shell is left in a ghost cwd.
  builtin cd "$main" || return 1

  if ! git -C "$main" worktree remove --force "$wt_root"; then
    echo "worktree rm: 'git worktree remove' failed for $wt_root (you're now in $main)." >&2
    return 1
  fi
  git -C "$main" worktree prune

  if [[ -z "$branch" ]]; then
    echo "removed worktree (detached HEAD, no branch to delete)."
  elif (( merged )); then
    git -C "$main" branch -D "$branch" >/dev/null 2>&1 \
      && echo "removed worktree and deleted merged branch $branch"
  else
    echo "removed worktree; KEPT branch $branch (not merged)."
    echo "  drop it too with: git -C '$main' branch -D '$branch'"
  fi
  echo "now in $main"
}
