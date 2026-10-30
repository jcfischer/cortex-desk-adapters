#!/usr/bin/env bun
/**
 * desk-mail: recent mail from the `email` CLI as Desk items.
 * Usage: desk-mail --account work --account personal [--days 3] [--limit 40] [--bodies 15]
 * Bodies are fetched read-only (no --mark-read) for the newest unread messages only.
 */
import { parseArgs } from "node:util";
import { toDeskMail, firstParagraph, type EmailListEntry } from "../src/mail";
import type { DeskSourceMail, DeskSourceOutput } from "../src/contract";

const { values } = parseArgs({
  options: {
    account: { type: "string", multiple: true, default: ["work"] },
    days: { type: "string", default: "3" },
    limit: { type: "string", default: "40" },
    bodies: { type: "string", default: "15" },
  },
});

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(["email", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`email ${args[0]} exited ${code}`);
  return out;
}

const items: DeskSourceMail[] = [];
for (const account of values.account ?? []) {
  const listed = JSON.parse(await run(["list", "-a", account, "-s", values.days ?? "3", "-l", values.limit ?? "40", "-o", "json"])) as EmailListEntry[];
  const unread = listed.filter((m) => !m.flags.includes("\\Seen")).slice(0, Number(values.bodies));
  const paragraphs = new Map<number, string | undefined>();
  for (const m of unread) {
    try {
      paragraphs.set(m.uid, firstParagraph(await run(["get", "-a", account, "-u", String(m.uid)])));
    } catch {
      paragraphs.set(m.uid, m.snippet);
    }
  }
  for (const m of listed) items.push(toDeskMail(m, account, paragraphs.get(m.uid) ?? m.snippet));
}

const output: DeskSourceOutput = { items };
process.stdout.write(JSON.stringify(output));
