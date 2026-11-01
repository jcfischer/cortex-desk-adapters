#!/usr/bin/env bun
/**
 * desk-mail-move: the Desk's move command (`mc.desk.mail.actions.move`). Reads one request on stdin and prints one result:
 *   { "action": "move", "account", "messageId", "target": "archive" | "junk" | "trash" } moves the one INBOX message
 *     with that Message-ID to the account's folder for the target;
 *   { "action": "restore", "account", "messageId", "from": "archive" | "junk" | "trash" } moves it back to INBOX (Undo).
 * IMAP MOVE only; it never deletes or expunges. Uses the `email` CLI's account config.
 * Usage: desk-mail-move [--mailbox INBOX]
 */
import { parseArgs } from "node:util";
import { withMailbox } from "../src/imap";
import { moveMessage, readMoveRequest, restoreMessage } from "../src/move";
import { runWriter } from "../src/writers";

const { values } = parseArgs({
  options: {
    mailbox: { type: "string" },
  },
});

await runWriter(async (text) => {
  const req = readMoveRequest(text);
  return withMailbox(req.account, (box) => (req.action === "move" ? moveMessage(req, box, values.mailbox) : restoreMessage(req, box, values.mailbox)));
});
