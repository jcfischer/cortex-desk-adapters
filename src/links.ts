import type { DeskMailLink } from "./contract";

const MAX_LINKS = 20;
const MAX_TEXT = 200;
const MAX_HREF = 2000;
const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const NAMES_HOST = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}/i;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16) || 32);
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10) || 32);
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const visible = (html: string): string => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/**
 * The links of an HTML body whose visible text names a host, such as "www.bank.example" or "https://bank.example/login",
 * with their http(s) target: what the Desk needs to see that a link shows one domain and opens another. At most 20.
 */
export function linksOf(html: string): DeskMailLink[] {
  const out: DeskMailLink[] = [];
  const seen = new Set<string>();
  ANCHOR.lastIndex = 0;
  for (let m = ANCHOR.exec(html); m !== null && out.length < MAX_LINKS; m = ANCHOR.exec(html)) {
    const attrs = HREF.exec(m[1] ?? "");
    const href = decode((attrs?.[1] ?? attrs?.[2] ?? attrs?.[3] ?? "").trim());
    const text = visible(m[2] ?? "");
    if (!/^https?:\/\//i.test(href) || href.length > MAX_HREF || !URL.canParse(href)) continue;
    if (!text || text.length > MAX_TEXT || !NAMES_HOST.test(text)) continue;
    const key = `${text}\n${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, href });
  }
  return out;
}
