import { ImapFlow } from "imapflow";
import type { ImapAccount } from "./imap-account";
import { imapAccount } from "./imap-account";
import type { DeskMailHeaders, DeskMailLink } from "./contract";
import { linksOf } from "./links";
import { MAX_ORIGINAL, TOO_LARGE, type PhishingReportBox } from "./report";
import { HEADER_FIELDS, headersOf } from "./mail-headers";
import { ReportRefusal, type Attachment, type ReportMailbox } from "./dmarc";
import { bareMessageId, type Mailbox } from "./move";
import { spawnRunner } from "./run";
import { Refusal } from "./writers";

/** A Mailbox over one ImapFlow connection; the caller connects and logs out. */
export function imapMailbox(client: ImapFlow): Mailbox {
  return {
    canMove: () => client.capabilities.has("MOVE"),
    open: async (path) => {
      const lock = await client.getMailboxLock(path);
      return () => lock.release();
    },
    findUids: async (messageId) => (await client.search({ header: { "message-id": messageId } }, { uid: true })) || [],
    messageIdOf: async (uid) => {
      const [m] = await client.fetchAll([uid], { envelope: true }, { uid: true });
      return m?.envelope?.messageId;
    },
    unread: async (uid) => {
      const [m] = await client.fetchAll([uid], { flags: true }, { uid: true });
      return !(m?.flags?.has("\\Seen") ?? false);
    },
    folders: async () => (await client.list()).map((b) => ({ path: b.path, name: b.name, ...(b.specialUse ? { specialUse: b.specialUse } : {}) })),
    move: async (uid, target) => Boolean(await client.messageMove([uid], target, { uid: true })),
  };
}

export function connectImap(account: ImapAccount): ImapFlow {
  return new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    ...(account.secure ? {} : { doSTARTTLS: true }),
    auth: { user: account.user, pass: account.pass },
    logger: false,
  });
}

async function withImapClient<T>(account: string, work: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = connectImap(await imapAccount(account, spawnRunner));
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch {
    throw new Refusal(`The ${account} mail server did not accept the connection.`);
  }
  try {
    return await work(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Connects to one account from the `email` CLI's config, runs `work` on its mailbox, and always logs out. */
export const withMailbox = <T>(account: string, work: (box: Mailbox) => Promise<T>): Promise<T> => withImapClient(account, (client) => work(imapMailbox(client)));

/** Reads the Desk's header fields for these INBOX UIDs, read-only (BODY.PEEK), so no message is marked read. */
export async function readHeaders(account: string, uids: number[], trustedAuthserv: readonly string[] = [], mailbox = "INBOX"): Promise<Map<number, DeskMailHeaders>> {
  const out = new Map<number, DeskMailHeaders>();
  if (uids.length === 0) return out;
  return withImapClient(account, async (client) => {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      for (const m of await client.fetchAll(uids, { headers: HEADER_FIELDS }, { uid: true })) {
        const headers = headersOf(m, trustedAuthserv);
        if (headers) out.set(m.uid, headers);
      }
    } finally {
      lock.release();
    }
    return out;
  });
}

interface Part {
  part?: string;
  type?: string;
  size?: number;
  parameters?: Record<string, string>;
  dispositionParameters?: Record<string, string>;
  childNodes?: Part[];
}

const leaves = (n: Part | undefined): Part[] => (!n ? [] : n.childNodes?.length ? n.childNodes.flatMap(leaves) : [n]);

/** The attachments of one message's body structure: media type, file name and encoded size. A single-part message is part 1. */
export const attachmentsOf = (structure: Part | undefined): (Attachment & { part: string })[] =>
  leaves(structure).map((p) => ({
    part: p.part ?? "1",
    type: (p.type ?? "").toLowerCase(),
    filename: p.dispositionParameters?.filename ?? p.parameters?.name ?? "",
    size: p.size ?? 0,
  }));

/**
 * A read-only ReportMailbox over one account's INBOX: the mailbox is opened with EXAMINE and parts are fetched with
 * BODY.PEEK, so the mail is never marked read. It refuses a Message-ID that matches no message or more than one.
 */
export async function withReportMailbox<T>(account: string, work: (box: ReportMailbox) => Promise<T>, mailbox = "INBOX"): Promise<T> {
  return withImapClient(account, async (client) => {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const uids = new Map<string, Promise<number>>();
      const findUid = async (messageId: string): Promise<number> => {
        const found = (await client.search({ header: { "message-id": messageId } }, { uid: true })) || [];
        const exact = found.length ? (await client.fetchAll(found, { envelope: true }, { uid: true })).filter((m) => bareMessageId(m.envelope?.messageId ?? "") === messageId) : [];
        const [only, ...others] = exact;
        if (!only) throw new Refusal(`The message is no longer in the ${account} ${mailbox}.`);
        if (others.length > 0) throw new ReportRefusal(`${exact.length} messages in the ${account} ${mailbox} share this Message-ID, so none was read.`);
        return only.uid;
      };
      const uidOf = (messageId: string): Promise<number> => {
        const known = uids.get(messageId) ?? findUid(messageId);
        uids.set(messageId, known);
        return known;
      };
      return await work({
        attachments: async (messageId) => {
          const [m] = await client.fetchAll([await uidOf(messageId)], { bodyStructure: true }, { uid: true });
          return attachmentsOf(m?.bodyStructure as Part | undefined);
        },
        download: async (messageId, part, maxBytes) => {
          const { content } = await client.download(String(await uidOf(messageId)), part, { uid: true, maxBytes });
          const chunks: Buffer[] = [];
          for await (const chunk of content) chunks.push(chunk as Buffer);
          return new Uint8Array(Buffer.concat(chunks));
        },
      });
    } finally {
      lock.release();
    }
  });
}

const htmlPart = (structure: Part | undefined): string | undefined => {
  const html = leaves(structure).find((p) => (p.type ?? "").toLowerCase() === "text/html" && !p.dispositionParameters?.filename);
  return html ? html.part ?? "1" : undefined;
};

/** The links of each message's HTML body, for these INBOX UIDs, read-only (EXAMINE, BODY.PEEK), so no message is marked read. */
export async function readLinks(account: string, uids: number[], warn: (line: string) => void = () => undefined, mailbox = "INBOX", maxBytes = 256 * 1024): Promise<Map<number, DeskMailLink[]>> {
  const out = new Map<number, DeskMailLink[]>();
  if (uids.length === 0) return out;
  return withImapClient(account, async (client) => {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      for (const m of await client.fetchAll(uids, { bodyStructure: true }, { uid: true })) {
        const part = htmlPart(m.bodyStructure as Part | undefined);
        if (!part) continue;
        try {
          const { content } = await client.download(String(m.uid), part, { uid: true, maxBytes });
          const chunks: Buffer[] = [];
          for await (const chunk of content) chunks.push(chunk as Buffer);
          const links = linksOf(Buffer.concat(chunks).toString("utf8"));
          if (links.length > 0) out.set(m.uid, links);
        } catch (err) {
          warn(`the links of message ${m.uid} were not read: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      lock.release();
    }
    return out;
  });
}

/** A PhishingReportBox over one account: originals are read with EXAMINE and BODY.PEEK; the draft is appended to Drafts. */
export function withPhishingReportBox<T>(account: string, work: (box: PhishingReportBox, user: string) => Promise<T>): Promise<T> {
  return imapAccount(account, spawnRunner).then((acct) => withImapClient(account, (client) => work({
    folders: async () => (await client.list()).map((b) => ({ path: b.path, name: b.name, ...(b.specialUse ? { specialUse: b.specialUse } : {}) })),
    source: async (folder, messageId) => {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const found = (await client.search({ header: { "message-id": messageId } }, { uid: true })) || [];
        if (found.length === 0) return undefined;
        const exact = (await client.fetchAll(found, { envelope: true, size: true }, { uid: true })).filter((m) => bareMessageId(m.envelope?.messageId ?? "") === messageId);
        const [only, ...others] = exact;
        if (!only) return undefined;
        if (others.length > 0) throw new Refusal(`${exact.length} messages in the ${account} ${folder} share this Message-ID, so none was reported.`);
        if ((only.size ?? 0) > MAX_ORIGINAL) throw new Refusal(TOO_LARGE);
        const message = await client.fetchOne(String(only.uid), { source: true }, { uid: true });
        return message && message.source ? new Uint8Array(message.source) : undefined;
      } finally {
        lock.release();
      }
    },
    append: async (folder, content, flags) => {
      const done = await client.append(folder, Buffer.from(content), flags);
      if (!done) throw new Refusal(`The ${account} mail server did not save the report draft.`);
    },
  }, acct.user)));
}
