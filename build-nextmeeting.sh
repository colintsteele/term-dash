#!/usr/bin/env bash
# Build bin/nextmeeting from nextmeeting.swift.
#
# The -sectcreate flags are load-bearing, not boilerplate. EventKit reads the
# usage description out of the binary's __TEXT,__info_plist section; a CLI has
# no bundle to read one from, so without this the permission prompt never
# appears and access is denied with no explanation. macOS 14+ wants the
# FullAccess key, older systems the plain one — ship both.
set -euo pipefail
cd "$(dirname "$0")"

PLIST=$(mktemp -t nextmeeting-plist)
trap 'rm -f "$PLIST"' EXIT

cat > "$PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.colinsteele.termdash.nextmeeting</string>
  <key>CFBundleName</key>
  <string>nextmeeting</string>
  <key>NSCalendarsUsageDescription</key>
  <string>term-dash shows your next meeting in the status strip.</string>
  <key>NSCalendarsFullAccessUsageDescription</key>
  <string>term-dash shows your next meeting in the status strip.</string>
</dict>
</plist>
PLIST

mkdir -p bin
swiftc -O nextmeeting.swift -o bin/nextmeeting \
  -framework EventKit -framework Foundation \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST"

# Ad-hoc signature. TCC keys a granted permission to the binary's identity; an
# unsigned binary gets a fresh identity on every rebuild, so the prompt would
# come back each time. Ad-hoc signing keeps it stable across rebuilds.
codesign --force --sign - bin/nextmeeting

echo "built bin/nextmeeting"
