#!/usr/bin/env bun
/**
 * desk-parse: the Desk parser command. Reads `{ text, now, timeZone, kinds, maps }` on stdin, asks a model
 * once through `claude -p`, and prints one `{ kind, fields }` or `{ kind: "none", reason }`.
 * Usage: desk-parse [--model haiku] [--claude claude]
 * Fails loudly: Cortex falls back to its own rules parser on any non-zero exit.
 */
import { parseArgs } from "node:util";
import { buildPrompt, extractJson, readParseRequest, validateParse } from "../src/parse";
import { lastLine, spawnRunner } from "../src/run";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "haiku" },
    claude: { type: "string", default: "claude" },
  },
});

try {
  const req = readParseRequest(await new Response(Bun.stdin.stream()).text());
  const out = await spawnRunner([values.claude ?? "claude", "-p", "--model", values.model ?? "haiku", "--output-format", "text"], buildPrompt(req));
  if (out.code !== 0) throw new Error(`claude exited ${out.code}: ${lastLine(out.stderr)}`);
  process.stdout.write(`${JSON.stringify(validateParse(extractJson(out.stdout), req))}\n`);
} catch (error) {
  process.stderr.write(`desk-parse: ${(error as Error).message}\n`);
  process.exit(1);
}
