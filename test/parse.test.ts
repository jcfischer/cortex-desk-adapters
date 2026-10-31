import { expect, it } from "bun:test";
import type { DeskParseRequest } from "../src/contract";
import { buildPrompt, extractJson, readParseRequest, validateParse } from "../src/parse";

const req: DeskParseRequest = {
  text: "dentist tomorrow at 14:00",
  now: "2026-10-30T09:15:00+01:00",
  timeZone: "Europe/Zurich",
  kinds: ["reminder", "calendar", "task"],
  maps: [{ ref: "the-metafactory/cortex#2770", label: "Desk" }],
};

it("reads a request and drops kinds it does not know", () => {
  const read = readParseRequest(JSON.stringify({ ...req, kinds: ["calendar", "spell"], maps: [{ ref: "a/b#1", label: "B" }, { nope: 1 }] }));
  expect(read.kinds).toEqual(["calendar"]);
  expect(read.maps).toEqual([{ ref: "a/b#1", label: "B" }]);
  expect(() => readParseRequest(JSON.stringify({ ...req, kinds: [] }))).toThrow("no known kinds");
  expect(() => readParseRequest(JSON.stringify({ ...req, now: "soon" }))).toThrow();
});

it("builds a prompt with the local time, only the asked kinds and the maps", () => {
  const prompt = buildPrompt(req);
  expect(prompt).toContain("Friday, 30 October 2026");
  expect(prompt).toContain("09:15");
  expect(prompt).toContain("- calendar:");
  expect(prompt).not.toContain("- goal:");
  expect(prompt).toContain('ref "the-metafactory/cortex#2770", label "Desk"');
  expect(prompt.endsWith("Text:\ndentist tomorrow at 14:00")).toBe(true);
  expect(buildPrompt({ ...req, maps: [] })).toContain("do not answer with kind task");
});

it("extracts the first JSON object from prose, a fence, or braces inside strings", () => {
  expect(extractJson('Sure:\n```json\n{"kind":"note","fields":{"text":"a } b"}}\n```')).toEqual({ kind: "note", fields: { text: "a } b" } });
  expect(extractJson('{ broken { "kind": "none", "reason": "x" }')).toEqual({ kind: "none", reason: "x" });
  expect(() => extractJson("no json here")).toThrow();
});

it("accepts a calendar answer and a none answer", () => {
  const cal = { kind: "calendar", fields: { title: "Dentist", start: "2026-10-31T14:00:00+01:00" } };
  expect(validateParse(cal, req)).toEqual(cal as never);
  expect(validateParse({ kind: "none", reason: "Not a request." }, req)).toEqual({ kind: "none", reason: "Not a request." });
});

it("refuses a kind not asked for, bad times, and a map not offered", () => {
  expect(() => validateParse({ kind: "goal", fields: { wording: "x" } }, req)).toThrow("not asked for");
  expect(() => validateParse({ kind: "reminder", fields: { text: "x", due: "tomorrow" } }, req)).toThrow("fields");
  expect(() => validateParse({ kind: "task", fields: { title: "x", map: "evil/repo#1" } }, req)).toThrow("fields");
  expect(validateParse({ kind: "task", fields: { title: "x", map: "the-metafactory/cortex#2770" } }, req).kind).toBe("task");
});

it("keeps the offered ref when the answer copies the label after it", () => {
  expect(validateParse({ kind: "task", fields: { title: "x", map: "the-metafactory/cortex#2770 (Desk)" } }, req))
    .toEqual({ kind: "task", fields: { title: "x", map: "the-metafactory/cortex#2770" } });
});
