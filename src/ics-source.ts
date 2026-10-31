import type { IcsWindow } from "./ics";

export function icsWindow(now: number, days: number): IcsWindow {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + days);
  return { from: today.getTime(), to: end.getTime() };
}

export async function readIcs(where: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (/^https:\/\//i.test(where)) {
    const res = await fetchImpl(where, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`The calendar URL answered HTTP ${res.status}.`);
    return res.text();
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(where)) throw new Error("Only https URLs and local files are read.");
  const file = Bun.file(where);
  if (!(await file.exists())) throw new Error(`There is no calendar file at ${where}.`);
  return file.text();
}
