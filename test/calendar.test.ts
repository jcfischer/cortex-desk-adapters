import { expect, it } from "bun:test";
import { dedupe, fromExchange, fromMac, localIso } from "../src/calendar";

it("maps an Exchange meeting with a Teams link", () => {
  const e = fromExchange({ date: "2026-10-30", startTime: "13:00", endTime: "14:00", title: "DA results", location: "Microsoft Teams Meeting", meetingLink: "https://teams.example/j/1" });
  expect(e).toEqual({ id: "2026-10-30|13:00|DA results", start: localIso("2026-10-30", "13:00"), end: localIso("2026-10-30", "14:00"), title: "DA results", location: "Microsoft Teams Meeting", online: true, url: "https://teams.example/j/1" });
});

it("treats an Exchange event without a start time as all-day", () => {
  expect(fromExchange({ date: "2026-11-05", isAllDay: true, title: "CotD" })).toMatchObject({ allDay: true, start: localIso("2026-11-05") });
});

it("maps a macOS event and keeps only web links", () => {
  expect(fromMac({ title: "Choir", calendar: "Personal", date: "2026-11-02", start_at: "20:00", end_at: "22:30", urls: ["x-apple:1", "https://choir.example"] }))
    .toEqual({ id: "Personal|2026-11-02|20:00|Choir", start: localIso("2026-11-02", "20:00"), end: localIso("2026-11-02", "22:30"), title: "Choir", url: "https://choir.example" });
  expect(fromMac({ title: "Guest stay", calendar: "Holiday flat", date: "2026-10-30" })).toMatchObject({ allDay: true });
});

it("collapses an event repeated in the list and sorts by start", () => {
  const a = fromMac({ title: "Guest stay", calendar: "Holiday flat", date: "2026-10-31" });
  const b = fromMac({ title: "Choir", calendar: "Personal", date: "2026-10-30", start_at: "20:00" });
  expect(dedupe([a, b, a]).map((e) => e.title)).toEqual(["Choir", "Guest stay"]);
});
