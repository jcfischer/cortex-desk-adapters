#!/usr/bin/env bun
/**
 * desk-mail-trash: the Desk's trash command. Reads `{ "action": "trash", "account", "messageId" }` on stdin and moves
 * the one INBOX message with that Message-ID to the account's Trash, using the `email` CLI's account config.
 * Usage: desk-mail-trash [--mailbox INBOX]
 */
import { parseArgs } from "node:util";
import { connectImap, imapMailbox } from "../src/imap";
import { spawnRunner } from "../src/run";
import { imapAccount, readTrashRequest, trashMessage } from "../src/trash";
import { Refusal, runWriter } from "../src/writers";

const { values } = parseArgs({
  options: {
    mailbox: { type: "string", default: "INBOX" },
  },
});

await runWriter(async (text) => {
  const req = readTrashRequest(text);
  const client = connectImap(await imapAccount(req.account, spawnRunner));
  try {
    await client.connect();
  } catch {
    throw new Refusal(`The ${req.account} mail server did not accept the connection.`);
  }
  try {
    return await trashMessage(req, imapMailbox(client), values.mailbox ?? "INBOX");
  } finally {
    await client.logout().catch(() => undefined);
  }
});
