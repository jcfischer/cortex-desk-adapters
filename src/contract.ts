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
