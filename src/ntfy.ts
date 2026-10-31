export interface DeskPush {
  key: string;
  title: string;
  why: string;
  action?: { label: string; url: string };
}

export function readPush(text: string): DeskPush {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("The push is not valid JSON.");
  }
  if (typeof body !== "object" || body === null || !("key" in body) || !("title" in body) || !("why" in body)) throw new Error("The push needs key, title and why.");
  const p = body;
  if (typeof p.key !== "string" || typeof p.title !== "string" || typeof p.why !== "string") throw new Error("The push needs key, title and why.");
  const a = "action" in p ? p.action : undefined;
  const action = typeof a === "object" && a !== null && "label" in a && "url" in a && typeof a.label === "string" && typeof a.url === "string" && /^https?:\/\//i.test(a.url) ? { label: a.label, url: new URL(a.url).href } : undefined;
  return { key: p.key, title: p.title, why: p.why, ...(action ? { action } : {}) };
}

const headerSafe = (s: string): string => s.replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7e]/g, "?").slice(0, 200);

export function ntfyRequest(push: DeskPush, server: string, topic: string, token: string | undefined): { url: string; init: RequestInit } {
  const headers: Record<string, string> = { Title: headerSafe(push.title), Tags: "desk" };
  if (push.action) {
    headers.Click = push.action.url;
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  return { url: `${server.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`, init: { method: "POST", headers, body: push.why } };
}
