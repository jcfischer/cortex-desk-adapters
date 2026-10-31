import { ImapFlow } from "imapflow";
import type { ImapAccount, Mailbox } from "./trash";
import { pickTrash } from "./trash";

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
    trashPath: async () => pickTrash(await client.list()),
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
