import type { DeskParseKind, DeskParseRequest, DeskParseResult } from "./contract";

const KINDS: DeskParseKind[] = ["reminder", "note", "task", "goal", "calendar"];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isIso = (v: unknown): v is string => isText(v) && /^\d{4}-\d{2}-\d{2}/.test(v) && Number.isFinite(Date.parse(v));

/** The parser's stdin, checked; throws on anything Cortex should not have sent. */
export function readParseRequest(text: string): DeskParseRequest {
  const body: unknown = JSON.parse(text);
  if (!isRecord(body) || !isText(body.text) || !isIso(body.now) || !isText(body.timeZone)) throw new Error("request needs text, now and timeZone");
  const kinds = Array.isArray(body.kinds) ? body.kinds.filter((k): k is DeskParseKind => KINDS.includes(k as DeskParseKind)) : [];
  if (kinds.length === 0) throw new Error("request names no known kinds");
  const maps = Array.isArray(body.maps)
    ? body.maps.filter((m): m is { ref: string; label: string } => isRecord(m) && isText(m.ref) && typeof m.label === "string")
    : [];
  return { text: body.text, now: body.now, timeZone: body.timeZone, kinds, maps };
}

const FIELDS: Record<DeskParseKind, string> = {
  reminder: '{ "text": string, "due": ISO 8601 with offset }',
  note: '{ "text": string }',
  task: '{ "title": string, "details"?: string, "map": one of the map refs below }',
  goal: '{ "wording": string, one line }',
  calendar: '{ "title": string, "start": ISO 8601 with offset, "end"?: ISO 8601 with offset, "allDay"?: boolean, "location"?: string, "notes"?: string }',
};

/** The one-shot prompt: the request, the allowed shapes, and the rules for times and maps. */
export function buildPrompt(req: DeskParseRequest): string {
  const local = new Date(req.now).toLocaleString("en-GB", { timeZone: req.timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return [
    "Turn one line a person typed into a command bar into exactly one JSON object. Answer with the JSON object only: no prose, no code fence.",
    "",
    `Now: ${req.now} (${local} in ${req.timeZone}).`,
    `Time zone: ${req.timeZone}.`,
    "",
    "Allowed kinds and their fields:",
    ...req.kinds.map((k) => `- ${k}: ${FIELDS[k]}`),
    '- none: when the text fits no allowed kind, answer { "kind": "none", "reason": one short sentence }.',
    "",
    'Shape: { "kind": <kind>, "fields": { ... } }.',
    "",
    "Rules:",
    `- Resolve relative times ("tomorrow at 9", "in 20 minutes", "Friday", "next week") against Now in ${req.timeZone}. Write every time as ISO 8601 with that zone's UTC offset, e.g. 2026-11-03T14:00:00+01:00.`,
    '- A weekday alone means the next such day after today. A day with no time is all-day for calendar ("allDay": true, start at 00:00).',
    "- Leave out optional fields you cannot read from the text. Do not invent details.",
    ...(req.kinds.includes("task")
      ? req.maps.length > 0
        ? [
            '- A task\'s "map" is the exact ref of one of these maps, chosen by its label; if none fits, use the first. Copy the ref only, never the label:',
            ...req.maps.map((m) => `  - ref ${JSON.stringify(m.ref)}, label ${JSON.stringify(m.label)}`),
          ]
        : ["- There are no maps, so do not answer with kind task."]
      : []),
    "",
    "Text:",
    req.text,
  ].join("\n");
}

/** The first balanced JSON object in a model's answer, string-aware, so prose or a fence around it does not matter. */
export function extractJson(answer: string): unknown {
  for (let start = answer.indexOf("{"); start !== -1; start = answer.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < answer.length; i++) {
      const c = answer[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          return JSON.parse(answer.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new Error("no JSON object in the answer");
}

const optText = (v: unknown) => v === undefined || typeof v === "string";

/** Minimal shape check against the request; Cortex validates again, this only stops obvious junk. */
export function validateParse(value: unknown, req: DeskParseRequest): DeskParseResult {
  if (!isRecord(value)) throw new Error("answer is not an object");
  if (value.kind === "none") {
    if (!isText(value.reason)) throw new Error("none needs a reason");
    return { kind: "none", reason: value.reason };
  }
  const kind = value.kind as DeskParseKind;
  if (!req.kinds.includes(kind)) throw new Error(`kind ${JSON.stringify(value.kind)} was not asked for`);
  const f = value.fields;
  if (!isRecord(f)) throw new Error("answer has no fields");
  // A model sometimes copies the label after the ref ("owner/name#1 (Desk)"); keep the offered ref.
  if (kind === "task" && typeof f.map === "string") f.map = req.maps.find((m) => f.map === m.ref || (f.map as string).startsWith(`${m.ref} `))?.ref ?? f.map;
  const ok = (() => {
    switch (kind) {
      case "reminder": return isText(f.text) && isIso(f.due);
      case "note": return isText(f.text);
      case "goal": return isText(f.wording) && !/[\r\n]/.test(f.wording);
      case "task": return isText(f.title) && optText(f.details) && req.maps.some((m) => m.ref === f.map);
      case "calendar":
        return isText(f.title) && isIso(f.start) && (f.end === undefined || isIso(f.end)) && (f.allDay === undefined || typeof f.allDay === "boolean")
          && optText(f.location) && optText(f.notes);
    }
  })();
  if (!ok) throw new Error(`fields do not fit kind ${kind}`);
  return { kind, fields: f } as DeskParseResult;
}
