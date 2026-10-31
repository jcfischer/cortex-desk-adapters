#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { ntfyRequest, readPush } from "../src/ntfy";

const { values } = parseArgs({
  options: {
    server: { type: "string", default: "https://ntfy.sh" },
    topic: { type: "string" },
    "token-env": { type: "string", default: "NTFY_TOKEN" },
  },
});

try {
  if (!values.topic) throw new Error("Usage: desk-ntfy --topic <topic> [--server https://ntfy.sh] [--token-env NTFY_TOKEN]");
  const server = values.server ?? "https://ntfy.sh";
  if (!/^https:\/\//i.test(server)) throw new Error("--server must be an https URL.");
  const push = readPush(await new Response(Bun.stdin.stream()).text());
  const token = process.env[values["token-env"] ?? "NTFY_TOKEN"]?.trim() || undefined;
  const { url, init } = ntfyRequest(push, server, values.topic, token);
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}.`);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
