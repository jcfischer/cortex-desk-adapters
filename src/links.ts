import type { DeskMailLink } from "./contract";
import { HOST_LABELS } from "./host";

const MAX_LINKS = 20;
const MAX_ANCHORS = 2000;
const MAX_TEXT = 200;
const MAX_HREF = 2000;
const OPEN = /<a\b([^>]*)>/gi;
const CLOSE = /<\/a\s*>/i;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const URL_LIKE = new RegExp(`^(?:https?://)?${HOST_LABELS}\\.?(?::\\d{1,5})?(?:[/?#]\\S*)?$`, "i");
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const codePoint = (n: number): string => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ");

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,8}|#\d{1,10}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (/^#x/i.test(name)) return codePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return codePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const visible = (html: string): string => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/**
 * The links of an HTML body whose whole visible text is a host or URL, such as "www.bank.example" or
 * "https://bank.example/login", with their http(s) target: what the Desk needs to see that a link shows one domain and
 * opens another. At most 20. Each anchor looks for its close in a bounded window, so unclosed anchors cannot stall it.
 */
export function linksOf(html: string): DeskMailLink[] {
  const out: DeskMailLink[] = [];
  const seen = new Set<string>();
  const open = new RegExp(OPEN.source, OPEN.flags);
  let anchors = 0;
  for (let m = open.exec(html); m !== null && out.length < MAX_LINKS && anchors < MAX_ANCHORS; m = open.exec(html)) {
    anchors += 1;
    const start = open.lastIndex;
    const rest = html.slice(start, start + MAX_HREF * 4);
    const close = CLOSE.exec(rest);
    if (!close) continue;
    open.lastIndex = start + close.index + close[0].length;
    const attrs = HREF.exec(m[1] ?? "");
    const href = decode((attrs?.[1] ?? attrs?.[2] ?? attrs?.[3] ?? "").trim());
    const text = visible(rest.slice(0, close.index));
    if (!/^https?:\/\//i.test(href) || href.length > MAX_HREF || !URL.canParse(href)) continue;
    if (!text || text.length > MAX_TEXT || !URL_LIKE.test(text)) continue;
    const key = `${text}\n${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, href });
  }
  return out;
}
