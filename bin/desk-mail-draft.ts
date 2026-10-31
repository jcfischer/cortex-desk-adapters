#!/usr/bin/env bun
/**
 * desk-mail-draft: the Desk's reply-draft command. Reads `{ "action": "draft", "account", "messageId", "to", "subject", "body" }`
 * on stdin and saves the reply in the account's Drafts with `email draft create`. It never sends mail.
 * Usage: desk-mail-draft [--email /path/to/email]
 */
import { parseArgs } from "node:util";
import { readDraftRequest, saveDraft } from "../src/draft";
import { spawnRunner } from "../src/run";
import { runWriter } from "../src/writers";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
  },
});

await runWriter(async (text) => saveDraft(readDraftRequest(text), spawnRunner, values.email));
