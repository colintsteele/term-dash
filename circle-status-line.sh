#!/usr/bin/env bash
#
# Fast launcher for the Claude Code statusLine (see circle-status-line.ts).
#
# Why this exists: the statusLine command runs on a timer, once PER open Claude
# Code window. Launching it as `npx tsx circle-status-line.ts` cold-boots
# npm → tsx → a TypeScript transpile every single time (~0.29s CPU, 132MB RSS).
# With ~9 windows on a 30s refresh that is a CPU burst every few seconds. Running
# the precompiled JS with plain `node` instead costs ~0.01s CPU (~29x less).
#
# To avoid the compiled JS silently going stale when you edit the .ts, this
# rebuilds it ONLY when the source is newer — so the hot path stays pure `node`
# and editing the .ts remains a one-step workflow. Point settings.json at THIS
# file. Does not change cwd: the .ts reads the caller's git branch.
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$dir/circle-status-line.ts"
out="$dir/circle-status-line.js"

if [ ! -f "$out" ] || [ "$src" -nt "$out" ]; then
  npx esbuild "$src" --bundle --platform=node --format=cjs --target=node20 \
    --outfile="$out" >/dev/null 2>&1 || true
fi

exec node "$out"
