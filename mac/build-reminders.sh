#!/bin/bash
# Builds desk-reminders-mac into ../dist, or into the directory given as the first argument: EventKit, an
# embedded Info.plist (the Reminders permission prompt's text) and an ad-hoc signature of its own.
# It builds only desk-reminders-mac, so desk-calendar-mac and its calendar grant stay as they are.
# A rebuild changes the binary's identity, so macOS asks for Reminders access again.
# Apple has no separate Reminders entitlement: EventKit reminders fall under the calendars key.
set -euo pipefail
out="$(mkdir -p "${1:-$(dirname "$0")/../dist}" && cd "${1:-$(dirname "$0")/../dist}" && pwd)"
cd "$(dirname "$0")"
swiftc -O -o "$out/desk-reminders-mac" reminders.swift -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker reminders-Info.plist
codesign --force --sign - --identifier ch.invisible.desk-reminders-mac --entitlements reminders-entitlements.plist "$out/desk-reminders-mac"
echo "built $out/desk-reminders-mac"
