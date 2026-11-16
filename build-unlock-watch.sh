#!/usr/bin/env bash
# Build bin/unlock-watch from unlock-watch.swift. No entitlements or Info.plist
# needed — unlike nextmeeting, it touches no permission-gated API. (The Chrome
# Automation prompt belongs to the osascript it runs, not to this binary.)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
swiftc -O -o bin/unlock-watch unlock-watch.swift
echo "built bin/unlock-watch"
