import type { DeskSourceMail } from "./contract";

/** One message as `email list -o json` prints it. */
export interface EmailListEntry {
  uid: number;
  messageId: string;
  from: string;
  subject: string;
  date: string;
  snippet?: string;
  flags: string[];
}

/** "Finance & Controlling <fc@example.ch>" → { name, address }. */
export function parseFrom(raw: string): { name?: string; address: string } {
  const match = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (!match) return { address: raw.trim().toLowerCase() };
  const name = match[1]?.trim();
  return { ...(name ? { name } : {}), address: (match[2] ?? "").trim().toLowerCase() };
}

/** Apple Mail opens a message from its Message-ID: message://%3Cid%3E. */
export function appleMailUrl(messageId: string): string {
  return `message://${encodeURIComponent(`<${messageId.replace(/^<|>$/g, "")}>`)}`;
}

const GREETING = /^(hi|hello|hallo|hoi|salut|bonjour|dear|liebe|lieber|sehr geehrte|grüezi|guten tag)\b.{0,60}[,!:]?$/i;

/**
 * The first paragraph a person would read: the body of `email get`, split on blank lines,
 * skipping a short greeting line, collapsed to one line and capped at 400 characters.
 */
export function firstParagraph(getOutput: string): string | undefined {
  const parts = getOutput.split(/^━+$/m);
  const body = (parts.length >= 3 ? parts.slice(2).join("") : getOutput).trim();
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const first = paragraphs.find((p) => !(p.length <= 60 && GREETING.test(p)));
  if (!first) return undefined;
  return first.length > 400 ? `${first.slice(0, 397).trimEnd()}…` : first;
}

export function toDeskMail(entry: EmailListEntry, account: string, paragraph: string | undefined): DeskSourceMail {
  return {
    kind: "mail",
    id: entry.messageId.replace(/^<|>$/g, ""),
    from: parseFrom(entry.from),
    subject: entry.subject || "(no subject)",
    receivedAt: new Date(entry.date).toISOString(),
    unread: !entry.flags.includes("\\Seen"),
    ...(paragraph ? { firstParagraph: paragraph } : {}),
    url: appleMailUrl(entry.messageId),
    account,
  };
}
