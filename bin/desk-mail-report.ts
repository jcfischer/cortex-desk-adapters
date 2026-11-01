#!/usr/bin/env bun
/**
 * desk-mail-report: the Desk's report command (`mc.desk.mail.report.command`). Reads
 * `{ "action": "report", "account", "messageId", "to" }` on stdin and saves a draft to `to` in the account's Drafts with
 * the original attached unchanged as message/rfc822. The original is read from INBOX, else Junk, without marking it read.
 * It never sends, moves or deletes mail. Uses the `email` CLI's account config.
 * Usage: desk-mail-report [--mailbox INBOX]
 */
import { parseArgs } from "node:util";
import { withPhishingReportBox } from "../src/imap";
import { readReportRequest, saveReportDraft } from "../src/report";
import { runWriter } from "../src/writers";

const { values } = parseArgs({
  options: {
    mailbox: { type: "string" },
  },
});

await runWriter(async (text) => {
  const req = readReportRequest(text);
  return withPhishingReportBox(req.account, (box, user) => saveReportDraft(req, box, { from: user, ...(values.mailbox ? { inbox: values.mailbox } : {}) }));
});
