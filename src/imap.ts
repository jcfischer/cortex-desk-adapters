import { ImapFlow } from "imapflow";
import type { ImapAccount } from "./imap-account";
import { imapAccount } from "./imap-account";
import type { DeskMailHeaders } from "./contract";
import { HEADER_FIELDS, parseMailHeaders } from "./mail-headers";
import type { Mailbox } from "./move";
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

/** Connects to one account from the `email` CLI's config, runs `work` on its mailbox, and always logs out. */
export async function withMailbox<T>(account: string, work: (box: Mailbox) => Promise<T>): Promise<T> {
  const client = connectImap(await imapAccount(account, spawnRunner));
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch {
    throw new Refusal(`The ${account} mail server did not accept the connection.`);
  }
  try {
    return await work(imapMailbox(client));
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Reads the Desk's header fields for these INBOX UIDs, read-only (BODY.PEEK), so no message is marked read. */
export async function readHeaders(account: string, uids: number[], mailbox = "INBOX"): Promise<Map<number, DeskMailHeaders>> {
  const out = new Map<number, DeskMailHeaders>();
  if (uids.length === 0) return out;
  const client = connectImap(await imapAccount(account, spawnRunner));
  client.on("error", () => undefined);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      for (const m of await client.fetchAll(uids, { headers: [...HEADER_FIELDS] }, { uid: true })) {
        const headers = m.headers ? parseMailHeaders(m.headers.toString("utf8")) : undefined;
        if (headers) out.set(m.uid, headers);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  return out;
}
