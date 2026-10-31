/**
 * The Desk source contract (cortex#2772): a source is a command that prints one JSON object on stdout.
 * Cortex runs it from `mc.desk.sources`, validates this shape and drops what does not match.
 */

export interface DeskSourceEvent {
  /** Stable within the source, e.g. the calendar's event id or date+title. */
  id: string;
  /** ISO 8601 start. For an all-day event, the day at 00:00 local time. */
  start: string;
  end?: string;
  allDay?: boolean;
  title: string;
  location?: string;
  online?: boolean;
  /** A link that opens the event or joins the meeting. */
  url?: string;
  /** The calendar the event belongs to, e.g. for per-calendar colours. */
  calendar?: string;
}

export interface DeskSourceMail {
  kind: "mail";
  /** The RFC 5322 Message-ID without angle brackets. */
  id: string;
  from: { name?: string; address: string };
  subject: string;
  /** ISO 8601. */
  receivedAt: string;
  unread: boolean;
  firstParagraph?: string;
  /** Opens the message in the principal's mail client, e.g. message://%3Cid%3E for Apple Mail. */
  url?: string;
  account?: string;
}

export interface DeskSourceOutput {
  events?: DeskSourceEvent[];
  items?: DeskSourceMail[];
}

/**
 * The Desk writer contract (cortex#2774): Cortex writes one DeskWriteInput (a DeskWriteRequest plus its requestId) to a writer's stdin.
 * On success the writer exits 0 and prints one DeskWriteResult; on refusal it exits non-zero and the
 * last line of stderr, one plain sentence, is shown to the person. A writer creates nothing it refuses.
 */
export type DeskWriteKind = "calendar" | "task" | "goal" | "note" | "reminder";

export interface DeskCalendarFields {
  title: string;
  /** ISO 8601. */
  start: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  notes?: string;
}

export interface DeskTaskFields {
  title: string;
  details?: string;
  /** A work-graph root ref, e.g. the-metafactory/cortex#2770. */
  map: string;
}

export interface DeskGoalFields {
  wording: string;
}

export type DeskWriteRequest =
  | { kind: "calendar"; fields: DeskCalendarFields }
  | { kind: "task"; fields: DeskTaskFields }
  | { kind: "goal"; fields: DeskGoalFields }
  | { kind: "note"; fields: { text: string } }
  | { kind: "reminder"; fields: { text: string; due: string } };

/**
 * What a writer reads on stdin: a request plus the id of the confirmed Desk card, 8–64 of [A-Za-z0-9_-].
 * Every retry of one card carries the same id, so a writer can recognise a write it already made.
 */
export type DeskWriteInput = DeskWriteRequest & { requestId: string };

export interface DeskWriteResult {
  id: string;
  /** http(s) only. */
  url?: string;
  /** One plain sentence for the person. */
  message?: string;
}

/** The Desk parser contract: Cortex writes one DeskParseRequest to the parser's stdin. */
export type DeskParseKind = DeskWriteKind;

export interface DeskParseRequest {
  text: string;
  /** ISO 8601. */
  now: string;
  /** IANA, e.g. Europe/Zurich. */
  timeZone: string;
  kinds: DeskParseKind[];
  maps: { ref: string; label: string }[];
}

/** The parser prints one of these; Cortex validates it and falls back to its own rules on any failure. */
export type DeskParseResult =
  | DeskWriteRequest
  | { kind: "none"; reason: string };

/** The Desk mail-action contract: Cortex writes this to the `mc.desk.mail.actions.trash` command's stdin. */
export interface DeskMailActionRequest {
  action: "trash";
  /** The account name the mail source put on the item. */
  account: string;
  /** The Message-ID without angle brackets, as the mail source sent it. */
  messageId: string;
}
