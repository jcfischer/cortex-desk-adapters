import type { DeskMailDraftRequest, DeskWriteResult } from "./contract";
import { isRecord } from "./guards";
import { lastLine, type Runner } from "./run";
import { Refusal } from "./writers";

const MESSAGE_ID = /^[^\s<>]{1,512}$/;
const ACCOUNT = /^[\w.-]{1,64}$/;
const ADDRESS = /^[^\s<>,@]+@[^\s<>,@]+$/;
const MAX_SUBJECT = 900;
const MAX_BODY = 20_000;

const bare = (id: string): string => id.trim().replace(/^<|>$/g, "");

/** Parses `{ action: "draft", account, messageId, to, subject, body }`, refusing anything else. */
export function readDraftRequest(text: string): DeskMailDraftRequest {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refusal("The request is not valid JSON.");
  }
  if (!isRecord(body) || body.action !== "draft") throw new Refusal("This command only saves reply drafts.");
  const { account, messageId, to, subject } = body;
  const reply = body.body;
  if (typeof account !== "string" || !ACCOUNT.test(account)) throw new Refusal("The request names no valid account.");
  if (typeof messageId !== "string" || !MESSAGE_ID.test(bare(messageId))) throw new Refusal("The request has no valid Message-ID.");
  if (typeof to !== "string" || !ADDRESS.test(to.trim())) throw new Refusal("The request has no valid recipient address.");
  if (typeof subject !== "string" || subject.trim() === "" || subject.length > MAX_SUBJECT || /[\r\n]/.test(subject)) {
    throw new Refusal("The request has no valid subject.");
  }
  if (typeof reply !== "string" || reply.trim() === "") throw new Refusal("The reply is empty.");
  if (reply.length > MAX_BODY) throw new Refusal(`The reply is longer than ${MAX_BODY} characters.`);
  return { action: "draft", account, messageId: bare(messageId), to: to.trim(), subject: subject.trim(), body: reply };
}

const parseRecord = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const parsed = (stdout: string): Record<string, unknown> | undefined => {
  const text = stdout.trim();
  const start = text.search(/^\{/m);
  return parseRecord(text) ?? (start > 0 ? parseRecord(text.slice(start)) : undefined);
};

/**
 * Saves the reply in the account's Drafts through `email draft create`, threaded to the original with In-Reply-To.
 * The body goes on stdin and every option as `--name=value`, so neither can be read as another option. It never sends.
 */
export async function saveDraft(req: DeskMailDraftRequest, run: Runner, emailBin = "email"): Promise<DeskWriteResult> {
  const argv = [
    emailBin, "draft", "create",
    `--account=${req.account}`, `--to=${req.to}`, `--subject=${req.subject}`, `--in-reply-to=<${req.messageId}>`,
    "--no-markdown", "--output=json",
  ];
  const result = await run(argv, req.body);
  const out = parsed(result.stdout);
  if (result.code === 0 && out?.success !== true && out?.success !== false) {
    throw new Refusal(`The email CLI gave no confirmation that the draft was saved; check ${req.account} Drafts before trying again.`);
  }
  if (result.code !== 0 || !out || out.success === false) {
    const why = typeof out?.error === "string" && out.error ? out.error : lastLine(result.stderr) || `email exited with code ${result.code}`;
    throw new Refusal(`The ${req.account} mail server did not save the draft: ${why.replace(/\s*\n\s*/g, " ")}`);
  }
  const id = typeof out.messageId === "string" ? bare(out.messageId) : "";
  const mailbox = typeof out.mailbox === "string" && out.mailbox ? out.mailbox : "Drafts";
  return { id, message: `Draft saved in ${req.account} ${mailbox}.` };
}
