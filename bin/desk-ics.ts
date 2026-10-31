#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { readIcs, icsWindow } from "../src/ics-source";
import { parseIcs } from "../src/ics";
import type { DeskSourceOutput } from "../src/contract";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { days: { type: "string", default: "7" } },
});

const where = positionals[0];
if (!where || positionals.length > 1) {
  process.stderr.write("Usage: desk-ics <file.ics or https URL> [--days 7]\n");
  process.exit(2);
}

try {
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error("--days must be a whole number from 1 to 60.");
  const { events, skipped } = parseIcs(await readIcs(where), icsWindow(Date.now(), days));
  if (skipped > 0) process.stderr.write(`desk-ics: skipped ${skipped} event(s) it cannot read, such as a recurrence rule other than daily or weekly.\n`);
  const output: DeskSourceOutput = { events };
  process.stdout.write(JSON.stringify(output));
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
