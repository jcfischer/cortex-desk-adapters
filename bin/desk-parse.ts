#!/usr/bin/env bun
/**
 * desk-parse: the Desk parser command. Reads `{ text, now, timeZone, kinds, maps }` on stdin, asks a model
 * once through `claude -p`, and prints one `{ kind, fields }` or `{ kind: "none", reason }`.
 * Usage: desk-parse [--model haiku] [--claude claude]
 * Fails loudly: Cortex falls back to its own rules parser on any non-zero exit.
 */
import { parseArgs } from "node:util";
import { buildPrompt, extractJson, readParseRequest, validateParse } from "../src/parse";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "haiku" },
    claude: { type: "string", default: "claude" },
  },
});

try {
  const req = readParseRequest(await new Response(Bun.stdin.stream()).text());
  const proc = Bun.spawn([values.claude ?? "claude", "-p", "--model", values.model ?? "haiku", "--output-format", "text"], {
    stdin: new TextEncoder().encode(buildPrompt(req)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [answer, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`claude exited ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`);
  process.stdout.write(`${JSON.stringify(validateParse(extractJson(answer), req))}\n`);
} catch (error) {
  process.stderr.write(`desk-parse: ${(error as Error).message}\n`);
  process.exit(1);
}
