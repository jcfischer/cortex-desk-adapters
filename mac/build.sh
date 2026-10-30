#!/bin/bash
# Builds desk-calendar-mac into ../dist, or into the directory given as the first argument: EventKit, an
# embedded Info.plist (the permission prompt's text) and an ad-hoc signature with the calendar entitlement.
# A rebuild changes the binary's identity, so macOS asks for calendar access again; build elsewhere
# (./mac/build.sh /tmp/x) to check a change without dropping the grant of the binary in use.
set -euo pipefail
out="$(mkdir -p "${1:-$(dirname "$0")/../dist}" && cd "${1:-$(dirname "$0")/../dist}" && pwd)"
cd "$(dirname "$0")"
swiftc -O -o "$out/desk-calendar-mac" main.swift -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
codesign --force --sign - --identifier ch.invisible.desk-calendar-mac --entitlements entitlements.plist "$out/desk-calendar-mac"
echo "built $out/desk-calendar-mac"
