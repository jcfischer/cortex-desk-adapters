#!/usr/bin/env bun
/**
 * desk-mail-trash: the Desk's legacy trash command. Reads `{ "action": "trash", "account", "messageId" }` on stdin and moves
 * the one INBOX message with that Message-ID to the account's Trash, using the `email` CLI's account config.
 * desk-mail-move does the same and more; this command stays for stacks that still set `mc.desk.mail.actions.trash`.
 * Usage: desk-mail-trash [--mailbox INBOX]
 */
import { parseArgs } from "node:util";
import { withMailbox } from "../src/imap";
import { moveMessage, readTrashRequest } from "../src/move";
import { runWriter } from "../src/writers";

const { values } = parseArgs({
  options: {
    mailbox: { type: "string" },
  },
});

await runWriter(async (text) => {
  const req = readTrashRequest(text);
  return withMailbox(req.account, (box) => moveMessage(req, box, values.mailbox));
});
