import type { DeskAuthVerdict, DeskMailHeaders } from "./contract";

export const HEADER_FIELDS = ["list-id", "list-unsubscribe", "list-unsubscribe-post", "authentication-results", "reply-to", "in-reply-to"] as const;

const VERDICTS: readonly DeskAuthVerdict[] = ["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "policy"];
const MAX = { listId: 300, listUnsubscribe: 2000, listUnsubscribePost: 200, replyTo: 300, inReplyTo: 1000 };

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function unfold(raw: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const joined: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && joined.length > 0) joined[joined.length - 1] += ` ${line.trim()}`;
    else if (line.trim()) joined.push(line);
  }
  for (const line of joined) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).replace(CONTROL, "").replace(/\s+/g, " ").trim();
    if (!value) continue;
    fields.set(name, [...(fields.get(name) ?? []), value]);
  }
  return fields;
}

const capped = (value: string | undefined, max: number): string | undefined => (value && value.length <= max ? value : undefined);

function verdict(results: string, method: "spf" | "dkim" | "dmarc"): DeskAuthVerdict | undefined {
  const found = new RegExp(`(?:^|[;\\s])${method}\\s*=\\s*([a-z]+)`, "i").exec(results)?.[1]?.toLowerCase();
  return VERDICTS.find((v) => v === found);
}

function authResults(values: string[] | undefined): DeskMailHeaders["authResults"] {
  const first = values?.[0];
  if (!first) return undefined;
  const spf = verdict(first, "spf");
  const dkim = verdict(first, "dkim");
  const dmarc = verdict(first, "dmarc");
  return spf || dkim || dmarc ? { ...(spf ? { spf } : {}), ...(dkim ? { dkim } : {}), ...(dmarc ? { dmarc } : {}) } : undefined;
}

/**
 * The headers later Desk steps need, from a raw header block. Values are unfolded, stripped of control characters and
 * dropped when too long; Authentication-Results keeps only the topmost header's SPF, DKIM and DMARC verdicts. A header
 * that cannot be read is left out, so a malformed message never drops the mail.
 */
export function parseMailHeaders(raw: string): DeskMailHeaders | undefined {
  const fields = unfold(raw);
  const one = (name: string, max: number): string | undefined => capped(fields.get(name)?.[0], max);
  const headers: DeskMailHeaders = {};
  const listId = one("list-id", MAX.listId);
  const listUnsubscribe = one("list-unsubscribe", MAX.listUnsubscribe);
  const listUnsubscribePost = one("list-unsubscribe-post", MAX.listUnsubscribePost);
  const auth = authResults(fields.get("authentication-results"));
  const replyTo = one("reply-to", MAX.replyTo);
  const inReplyTo = one("in-reply-to", MAX.inReplyTo);
  if (listId) headers.listId = listId;
  if (listUnsubscribe) headers.listUnsubscribe = listUnsubscribe;
  if (listUnsubscribePost) headers.listUnsubscribePost = listUnsubscribePost;
  if (auth) headers.authResults = auth;
  if (replyTo) headers.replyTo = replyTo;
  if (inReplyTo) headers.inReplyTo = inReplyTo;
  return Object.keys(headers).length > 0 ? headers : undefined;
}
