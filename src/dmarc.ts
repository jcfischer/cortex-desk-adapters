import { inflateRawSync, gunzipSync } from "node:zlib";
import type { DeskDmarcDomain, DeskDmarcReport, DeskDmarcRequest, DeskDmarcSource } from "./contract";
import { isRecord } from "./guards";
import { bareMessageId } from "./move";
import { Refusal } from "./writers";

/** A report the command will not read: malformed, oversized or not a DMARC aggregate report. Exit 3, never retried. */
export class ReportRefusal extends Refusal {}

export const MAX_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_XML_BYTES = 8 * 1024 * 1024;
export const MAX_RECORDS = 20_000;
export const MAX_FAILING_SOURCES = 5;

const MESSAGE_ID = /^[^\s<>]{1,512}$/;
const ACCOUNT = /^[\w.-]{1,64}$/;

/** Parses `{ action: "dmarc", account, messageId }`, refusing anything else. */
export function readDmarcRequest(text: string): DeskDmarcRequest {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refusal("The request is not valid JSON.");
  }
  if (!isRecord(body) || body.action !== "dmarc") throw new Refusal("This command only reads DMARC aggregate reports.");
  const { account, messageId } = body;
  if (typeof account !== "string" || !ACCOUNT.test(account)) throw new Refusal("The request names no valid account.");
  if (typeof messageId !== "string" || !MESSAGE_ID.test(bareMessageId(messageId))) throw new Refusal("The request has no valid Message-ID.");
  return { action: "dmarc", account, messageId: bareMessageId(messageId) };
}

export interface Attachment {
  type: string;
  filename: string;
  size: number;
}

type Packing = "gzip" | "zip" | "xml";

/** How an attachment is packed, from its media type and file name; null for a part that is not a report. */
export function packingOf(a: Pick<Attachment, "type" | "filename">): Packing | null {
  const type = a.type.toLowerCase();
  const name = a.filename.toLowerCase();
  if (type === "application/gzip" || type === "application/x-gzip" || name.endsWith(".gz")) return "gzip";
  if (type === "application/zip" || type === "application/x-zip-compressed" || name.endsWith(".zip")) return "zip";
  if (type === "text/xml" || type === "application/xml" || name.endsWith(".xml")) return "xml";
  return null;
}

/** The one report attachment of a mail. Refuses a mail without one, with more than one, or with one over the size cap. */
export function reportAttachment<T extends Attachment>(parts: readonly T[]): T & { packing: Packing } {
  const reports = parts.flatMap((p) => {
    const packing = packingOf(p);
    return packing ? [{ ...p, packing }] : [];
  });
  const [first, ...others] = reports;
  if (!first) throw new ReportRefusal("The mail has no DMARC report attachment (zip, gzip or XML).");
  if (others.length > 0) throw new ReportRefusal(`The mail has ${reports.length} report attachments; the Desk reads mails with exactly one.`);
  if (first.size > Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4096) throw tooLarge();
  return first;
}

const tooLarge = (): ReportRefusal => new ReportRefusal(`The report attachment is larger than ${MAX_ATTACHMENT_BYTES / 1024} KiB, so it was not read.`);
const unpacksTooLarge = (what: string): ReportRefusal => new ReportRefusal(`The ${what} unpacks to more than ${MAX_XML_BYTES / 1024 / 1024} MiB, so it was not read.`);

function inflate(run: () => Buffer, what: string): Buffer {
  try {
    return run();
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw unpacksTooLarge(what);
    throw new ReportRefusal(`The ${what} is damaged and could not be unpacked.`);
  }
}

const u16 = (b: Buffer, at: number): number => b.readUInt16LE(at);
const u32 = (b: Buffer, at: number): number => b.readUInt32LE(at);

/** Reads the single file of a zip archive (stored or deflated), from its central directory. */
function unzip(bytes: Buffer): Buffer {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > bytes.length) throw new ReportRefusal("The zip attachment is damaged: it has no central directory.");
  const entries = u16(bytes, eocd + 10);
  if (entries !== 1) throw new ReportRefusal(`The zip attachment holds ${entries} files; a DMARC report holds one.`);
  const cd = u32(bytes, eocd + 16);
  if (cd + 46 > bytes.length || u32(bytes, cd) !== 0x02014b50) throw new ReportRefusal("The zip attachment is damaged.");
  const flags = u16(bytes, cd + 8);
  const method = u16(bytes, cd + 10);
  const compressed = u32(bytes, cd + 20);
  const size = u32(bytes, cd + 24);
  const local = u32(bytes, cd + 42);
  if ((flags & 1) === 1) throw new ReportRefusal("The zip attachment is encrypted, so it was not read.");
  if (size > MAX_XML_BYTES) throw unpacksTooLarge("zip attachment");
  if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) throw new ReportRefusal("The zip attachment is damaged.");
  const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
  const data = bytes.subarray(start, start + compressed);
  if (data.length !== compressed) throw new ReportRefusal("The zip attachment is truncated.");
  if (method !== 0 && method !== 8) throw new ReportRefusal("The zip attachment uses a compression the Desk does not read.");
  const file = method === 0 ? Buffer.from(data) : inflate(() => inflateRawSync(data, { maxOutputLength: MAX_XML_BYTES }), "zip attachment");
  if (file.length !== size) throw new ReportRefusal("The zip attachment is damaged: its file is not the size it declares.");
  return file;
}

/** The report XML from the attachment's bytes, unpacked under the size caps. */
export function unpack(bytes: Uint8Array, packing: Packing): string {
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw tooLarge();
  const buf = Buffer.from(bytes);
  const xml = packing === "gzip" ? inflate(() => gunzipSync(buf, { maxOutputLength: MAX_XML_BYTES }), "gzip attachment") : packing === "zip" ? unzip(buf) : buf;
  if (xml.length > MAX_XML_BYTES) throw unpacksTooLarge("report");
  return new TextDecoder("utf-8", { fatal: false }).decode(xml);
}

interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

const codePoint = (n: number): string => String.fromCodePoint(Number.isInteger(n) && n > 0 && n <= 0x10ffff ? n : 0xfffd);

function decodeText(raw: string): string {
  return raw.replace(/&(#x[0-9a-f]{1,8}|#\d{1,10}|\w{1,10});/gi, (whole, ref: string) => {
    if (ref.startsWith("#x") || ref.startsWith("#X")) return codePoint(Number.parseInt(ref.slice(2), 16));
    if (ref.startsWith("#")) return codePoint(Number.parseInt(ref.slice(1), 10));
    return ENTITIES[ref] ?? whole;
  });
}

const localName = (qname: string): string => qname.slice(qname.indexOf(":") + 1).toLowerCase();

/**
 * A small XML reader for the RFC 7489 aggregate format: elements and text only. It refuses any DOCTYPE or entity
 * declaration (no external entities, no expansion) and mismatched tags; attributes and processing instructions are ignored.
 */
export function parseXml(xml: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ReportRefusal("The report declares a DOCTYPE or entities, so it was not read.");
  const body = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")).replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  const root: XmlNode = { name: "#root", children: [], text: "" };
  const stack: XmlNode[] = [root];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s[^<>]*)?)(\/?)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(body)) !== null) {
    const top = stack[stack.length - 1];
    if (!top) throw new ReportRefusal("The report is not well-formed XML.");
    if (m[6] !== undefined) throw new ReportRefusal("The report is not well-formed XML.");
    if (m[5] !== undefined) {
      top.text += decodeText(m[5]);
      continue;
    }
    const name = localName(m[2] ?? "");
    if (m[1] === "/") {
      if (top.name !== name || stack.length === 1) throw new ReportRefusal("The report is not well-formed XML: its tags do not match.");
      stack.pop();
      continue;
    }
    const node: XmlNode = { name, children: [], text: "" };
    top.children.push(node);
    if (m[4] !== "/" && !(m[3] ?? "").endsWith("/")) stack.push(node);
  }
  if (stack.length !== 1) throw new ReportRefusal("The report is not well-formed XML: it ends inside an element.");
  const elements = root.children;
  if (elements.length !== 1 || !elements[0]) throw new ReportRefusal("The report is not well-formed XML: it needs exactly one root element.");
  return elements[0];
}

const child = (n: XmlNode | undefined, name: string): XmlNode | undefined => n?.children.find((c) => c.name === name);
const all = (n: XmlNode | undefined, name: string): XmlNode[] => n?.children.filter((c) => c.name === name) ?? [];
const textOf = (n: XmlNode | undefined, ...path: string[]): string => {
  let at = n;
  for (const p of path) at = child(at, p);
  return at?.text.trim() ?? "";
};

const DOMAIN = /^[a-z0-9_](?:[a-z0-9_.-]{0,251}[a-z0-9])?$/;
const IP = /^[0-9a-f:.]{2,45}$/;

const cleanDomain = (raw: string): string | null => {
  const d = raw.trim().toLowerCase().replace(/\.$/, "");
  return DOMAIN.test(d) && d.includes(".") ? d : null;
};

const line = (raw: string, max: number): string => raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function epoch(raw: string, what: string): string {
  const n = Number(raw);
  if (!/^\d{1,12}$/.test(raw) || !Number.isFinite(n)) throw new ReportRefusal(`The report has no valid ${what} date.`);
  return new Date(n * 1000).toISOString();
}

type Verdict = "pass" | "fail";
const verdict = (raw: string): Verdict => (raw.toLowerCase() === "pass" ? "pass" : "fail");
const DISPOSITIONS = ["none", "quarantine", "reject"] as const;

interface Tally extends DeskDmarcDomain {
  bySource: Map<string, DeskDmarcSource>;
}

const emptyTally = (domain: string): Tally => ({ domain, messages: 0, spf: { pass: 0, fail: 0 }, dkim: { pass: 0, fail: 0 }, dmarcFail: 0, disposition: { none: 0, quarantine: 0, reject: 0 }, failing: [], bySource: new Map() });

function tally(t: Tally, source: string, spf: Verdict, dkim: Verdict, disposition: (typeof DISPOSITIONS)[number], count: number): void {
  const dmarcFailed = spf === "fail" && dkim === "fail";
  t.messages += count;
  t.spf[spf] += count;
  t.dkim[dkim] += count;
  t.disposition[disposition] += count;
  if (dmarcFailed) t.dmarcFail += count;
  if ((spf === "pass" && dkim === "pass") || count === 0) return;
  const s = t.bySource.get(source) ?? { ip: source, count: 0, spfFail: 0, dkimFail: 0, dmarcFail: 0 };
  s.count += count;
  if (spf === "fail") s.spfFail += count;
  if (dkim === "fail") s.dkimFail += count;
  if (dmarcFailed) s.dmarcFail += count;
  t.bySource.set(source, s);
}

/** Per-domain counts from a parsed aggregate report: one entry per header_from domain, failing sources ranked by count. */
export function reportFrom(root: XmlNode, id: string): DeskDmarcReport {
  if (root.name !== "feedback") throw new ReportRefusal("The attachment is not a DMARC aggregate report (no <feedback> root).");
  const meta = child(root, "report_metadata");
  const policyDomain = cleanDomain(textOf(root, "policy_published", "domain"));
  if (!meta || !policyDomain) throw new ReportRefusal("The report has no report metadata or no published policy domain.");
  const records = all(root, "record");
  if (records.length > MAX_RECORDS) throw new ReportRefusal(`The report has more than ${MAX_RECORDS} records, so it was not read.`);
  const tallies = new Map<string, Tally>();
  for (const record of records) {
    const row = child(record, "row");
    const rawCount = textOf(row, "count");
    const count = Number(rawCount);
    if (!/^\d{1,15}$/.test(rawCount) || !Number.isSafeInteger(count)) throw new ReportRefusal("The report has a record without a valid count.");
    const domain = cleanDomain(textOf(record, "identifiers", "header_from")) ?? policyDomain;
    const ip = textOf(row, "source_ip").toLowerCase();
    const source = IP.test(ip) ? ip : "unknown";
    const spf = verdict(textOf(row, "policy_evaluated", "spf"));
    const dkim = verdict(textOf(row, "policy_evaluated", "dkim"));
    const disposition = DISPOSITIONS.find((d) => d === textOf(row, "policy_evaluated", "disposition").toLowerCase()) ?? "none";
    const t = tallies.get(domain) ?? emptyTally(domain);
    tally(t, source, spf, dkim, disposition, count);
    tallies.set(domain, t);
  }
  const domains = [...tallies.values()].map(({ bySource, ...d }): DeskDmarcDomain => ({
    ...d,
    failing: [...bySource.values()].sort((a, b) => b.count - a.count || a.ip.localeCompare(b.ip)).slice(0, MAX_FAILING_SOURCES),
  }));
  const messages = domains.reduce((n, d) => n + d.messages, 0);
  const failed = domains.reduce((n, d) => n + d.dmarcFail, 0);
  const org = line(textOf(meta, "org_name"), 120) || "an unnamed reporter";
  return {
    id,
    org,
    reportId: line(textOf(meta, "report_id"), 200),
    begin: epoch(textOf(meta, "date_range", "begin"), "begin"),
    end: epoch(textOf(meta, "date_range", "end"), "end"),
    policyDomain,
    domains,
    message: `Read the DMARC report from ${org} for ${policyDomain}: ${messages} messages, ${failed} failing DMARC.`,
  };
}

/** Reads one report attachment's bytes into the per-domain counts, or refuses with one sentence. Nothing in it is executed or rendered. */
export const readReport = (bytes: Uint8Array, packing: Packing, id: string): DeskDmarcReport => reportFrom(parseXml(unpack(bytes, packing)), id);

/** The few IMAP calls the DMARC command makes, so tests never reach a mail server. */
export interface ReportMailbox {
  attachments(messageId: string): Promise<(Attachment & { part: string })[]>;
  download(messageId: string, part: string, maxBytes: number): Promise<Uint8Array>;
}

/** Reads the report attached to the one inbox mail with this Message-ID. Read-only: the mail is not marked read or moved. */
export async function dmarcReport(req: DeskDmarcRequest, box: ReportMailbox): Promise<DeskDmarcReport> {
  const attachment = reportAttachment(await box.attachments(req.messageId));
  const bytes = await box.download(req.messageId, attachment.part, MAX_ATTACHMENT_BYTES + 1);
  return readReport(bytes, attachment.packing, req.messageId);
}
