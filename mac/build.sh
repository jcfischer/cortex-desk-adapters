#!/bin/bash
# Builds desk-calendar-mac into ../dist: EventKit, an embedded Info.plist (the permission prompt's text)
# and an ad-hoc signature with the calendar entitlement. A rebuild changes the binary's identity, so
# macOS asks for calendar access again.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../dist
swiftc -O -o ../dist/desk-calendar-mac main.swift -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
codesign --force --sign - --identifier ch.invisible.desk-calendar-mac --entitlements entitlements.plist ../dist/desk-calendar-mac
echo "built ../dist/desk-calendar-mac"
