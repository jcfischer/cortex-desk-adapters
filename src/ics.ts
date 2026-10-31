import type { DeskSourceEvent } from "./contract";

const DAY_MS = 86_400_000;
const MAX_SCAN_DAYS = 366 * 200;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface WallTime {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

interface IcsTime {
  wall: WallTime;
  allDay: boolean;
  utc: boolean;
  tzid?: string;
}

export interface IcsWindow {
  from: number;
  to: number;
}

export interface IcsResult {
  events: DeskSourceEvent[];
  skipped: number;
}

export function unfold(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n").filter((l) => l.length > 0);
}

export function parseProperty(line: string): IcsProperty | null {
  const colon = findValueColon(line);
  if (colon < 0) return null;
  const [rawName = "", ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: rawName.toUpperCase(), params, value: line.slice(colon + 1) };
}

function findValueColon(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\"") quoted = !quoted;
    if (line[i] === ":" && !quoted) return i;
  }
  return -1;
}

export const unescapeText = (v: string): string => v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

const TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

export function parseTime(prop: IcsProperty): IcsTime | null {
  const m = TIME.exec(prop.value.trim());
  if (!m) return null;
  const wall = { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: Number(m[4] ?? 0), mi: Number(m[5] ?? 0), s: Number(m[6] ?? 0) };
  const allDay = m[4] === undefined;
  const check = new Date(Date.UTC(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.s));
  if (check.getUTCFullYear() !== wall.y || check.getUTCMonth() + 1 !== wall.mo || check.getUTCDate() !== wall.d || wall.h > 23 || wall.mi > 59 || wall.s > 59) return null;
  if (prop.params.TZID && !validZone(prop.params.TZID)) return null;
  return { wall, allDay, utc: m[7] === "Z", ...(prop.params.TZID ? { tzid: prop.params.TZID } : {}) };
}

function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - at;
}

function validZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function toInstant(t: IcsTime): number {
  const { y, mo, d, h, mi, s } = t.wall;
  if (t.utc) return Date.UTC(y, mo - 1, d, h, mi, s);
  if (t.allDay || !t.tzid || !validZone(t.tzid)) return new Date(y, mo - 1, d, h, mi, s).getTime();
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - zoneOffset(guess, t.tzid);
  return guess - zoneOffset(first, t.tzid);
}

const shiftDays = (w: WallTime, days: number): WallTime => {
  const at = new Date(Date.UTC(w.y, w.mo - 1, w.d + days));
  return { ...w, y: at.getUTCFullYear(), mo: at.getUTCMonth() + 1, d: at.getUTCDate() };
};

const weekday = (w: WallTime): number => new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();

export interface Rule {
  freq: "DAILY" | "WEEKLY";
  interval: number;
  count?: number;
  until?: number;
  byDay?: number[];
}

export function parseRule(value: string): Rule | null {
  const parts: Record<string, string> = {};
  for (const part of value.split(";")) {
    const [key, val, extra] = part.split("=");
    if (!key || !val || extra !== undefined || key in parts) return null;
    parts[key] = val;
  }
  if (parts.FREQ !== "DAILY" && parts.FREQ !== "WEEKLY") return null;
  if (Object.keys(parts).some((k) => !["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY"].includes(k))) return null;
  const until = parts.UNTIL ? parseTime({ name: "UNTIL", params: {}, value: parts.UNTIL }) : null;
  const byDay = parts.BYDAY?.split(",").map((d) => WEEKDAYS.indexOf(d));
  if (byDay?.some((d) => d < 0)) return null;
  const interval = Number(parts.INTERVAL ?? 1);
  const count = parts.COUNT === undefined ? undefined : Number(parts.COUNT);
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) return null;
  if (count !== undefined && (!Number.isInteger(count) || count < 1)) return null;
  if (parts.UNTIL && !until) return null;
  if (parts.UNTIL && parts.COUNT) return null;
  return {
    freq: parts.FREQ,
    interval,
    ...(parts.COUNT ? { count: Number(parts.COUNT) } : {}),
    ...(until ? { until: until.allDay ? toInstant(until) + DAY_MS - 1 : toInstant(until) } : {}),
    ...(byDay ? { byDay } : {}),
  };
}

export function occurrences(start: IcsTime, rule: Rule | null, window: IcsWindow, length: number): IcsTime[] {
  if (!rule) {
    const at = toInstant(start);
    return at < window.to && (length === 0 ? at >= window.from : at + length > window.from) ? [start] : [];
  }
  const out: IcsTime[] = [];
  let seen = 0;
  const weekOf = (w: WallTime): number => Math.floor((Date.UTC(w.y, w.mo - 1, w.d) / DAY_MS - (weekday(w) + 6) % 7) / 7);
  const startWeek = weekOf(start.wall);
  const first = rule.count === undefined ? Math.max(0, Math.floor((window.from - length - toInstant(start)) / DAY_MS) - 2) : 0;
  for (let i = first; i < first + MAX_SCAN_DAYS; i++) {
    const wall = shiftDays(start.wall, i);
    const matches = rule.freq === "DAILY"
      ? i % rule.interval === 0 && (!rule.byDay || rule.byDay.includes(weekday(wall)))
      : (weekOf(wall) - startWeek) % rule.interval === 0 && (rule.byDay ?? [weekday(start.wall)]).includes(weekday(wall));
    const t = { ...start, wall };
    const at = toInstant(t);
    if (at >= window.to) break;
    if (!matches) continue;
    if (rule.until !== undefined && at > rule.until) break;
    seen += 1;
    if (rule.count !== undefined && seen > rule.count) break;
    if (length === 0 ? at >= window.from : at + length > window.from) out.push(t);
  }
  return out;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const SAFE_URL = /^https?:\/\//i;

export function parseIcs(text: string, window: IcsWindow): IcsResult {
  const events: DeskSourceEvent[] = [];
  let skipped = 0;
  let current: IcsProperty[] | null = null;
  for (const line of unfold(text)) {
    if (/^BEGIN:VEVENT$/i.test(line)) current = [];
    else if (/^END:VEVENT$/i.test(line)) {
      if (current) {
        const built = buildEvents(current, window);
        if (built === null) skipped += 1;
        else events.push(...built);
      }
      current = null;
    } else if (current) {
      const prop = parseProperty(line);
      if (prop) current.push(prop);
    }
  }
  events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { events, skipped };
}

function buildEvents(props: IcsProperty[], window: IcsWindow): DeskSourceEvent[] | null {
  const get = (name: string): IcsProperty | undefined => props.find((p) => p.name === name);
  if (get("RECURRENCE-ID") || get("STATUS")?.value.toUpperCase() === "CANCELLED") return [];
  const dtstart = get("DTSTART");
  const start = dtstart ? parseTime(dtstart) : null;
  const title = unescapeText(get("SUMMARY")?.value ?? "").trim();
  if (!start || !title) return null;
  const endProp = get("DTEND");
  const end = endProp ? parseTime(endProp) : null;
  if (endProp && !end) return null;
  if (get("RDATE") || get("DURATION")) return null;
  const startAt = toInstant(start);
  const length = end ? Math.max(0, toInstant(end) - startAt) : start.allDay ? DAY_MS : 0;
  const ruleProp = get("RRULE");
  const rule = ruleProp ? parseRule(ruleProp.value) : null;
  if (ruleProp && !rule) return null;
  const excluded = new Set(props.filter((p) => p.name === "EXDATE").flatMap((p) => p.value.split(",").map((v) => parseTime({ ...p, value: v })).filter((t) => t !== null).map(toInstant)));
  const uid = get("UID")?.value.trim() || `${title}@${start.wall.y}-${start.wall.mo}-${start.wall.d}`;
  const location = get("LOCATION") ? unescapeText(get("LOCATION")?.value ?? "").trim() : "";
  const url = get("URL")?.value.trim() ?? "";
  return occurrences(start, rule, window, length)
    .map((t) => toInstant(t))
    .filter((at) => !excluded.has(at))
    .map((at): DeskSourceEvent => ({
      id: rule ? `${uid}@${iso(at)}` : uid,
      start: iso(at),
      ...(length > 0 ? { end: iso(at + length) } : {}),
      ...(start.allDay ? { allDay: true } : {}),
      title,
      ...(location ? { location } : {}),
      ...(SAFE_URL.test(url) ? { url } : {}),
    }));
}
