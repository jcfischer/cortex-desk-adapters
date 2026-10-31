import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeskMailActionRequest, DeskWriteResult } from "./contract";
import { isRecord } from "./guards";
import type { Runner } from "./run";
import { Refusal } from "./writers";

export interface ImapAccount {
  name: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

/** The few IMAP calls the trash command makes, so tests never reach a mail server. */
export interface Mailbox {
  open(path: string): Promise<() => void>;
  findUids(messageId: string): Promise<number[]>;
  messageIdOf(uid: number): Promise<string | undefined>;
  trashPath(): Promise<string | undefined>;
  move(uid: number, target: string): Promise<boolean>;
}

const MESSAGE_ID = /^[^\s<>]{1,512}$/;
const ACCOUNT = /^[\w.-]{1,64}$/;
export const TRASH_NAMES = ["Trash", "Deleted Items", "Deleted Messages"];

export const emailConfigPath = (): string => join(homedir(), ".config", "email", "config.json");

const bare = (id: string): string => id.trim().replace(/^<|>$/g, "");

/** Parses `{ action: "trash", account, messageId }`, refusing anything else. */
export function readTrashRequest(text: string): DeskMailActionRequest {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refusal("The request is not valid JSON.");
  }
  if (!isRecord(body) || body.action !== "trash") throw new Refusal("This command only moves mail to Trash.");
  const { account, messageId } = body;
  if (typeof account !== "string" || !ACCOUNT.test(account)) throw new Refusal("The request names no valid account.");
  if (typeof messageId !== "string" || !MESSAGE_ID.test(bare(messageId))) throw new Refusal("The request has no valid Message-ID.");
  return { action: "trash", account, messageId: bare(messageId) };
}

/** Resolves a password the way the `email` CLI does: keychain:<service>, env:<VAR>, or the value itself. */
export async function resolvePassword(value: string, run: Runner, env: Record<string, string | undefined> = process.env): Promise<string> {
  if (value.startsWith("keychain:")) {
    const result = await run(["security", "find-generic-password", "-s", value.slice("keychain:".length), "-w"]);
    const pass = result.stdout.trim();
    if (result.code !== 0 || !pass) throw new Refusal("The mail password could not be read from the keychain.");
    return pass;
  }
  if (value.startsWith("env:")) {
    const pass = env[value.slice("env:".length)];
    if (!pass) throw new Refusal("The mail password's environment variable is not set.");
    return pass;
  }
  return value;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Reads one account's IMAP settings from the `email` CLI's config (~/.config/email/config.json). */
export async function imapAccount(name: string, run: Runner, path = emailConfigPath()): Promise<ImapAccount> {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Refusal("The email config could not be read.");
  }
  const accounts = isRecord(config) && isRecord(config.accounts) ? config.accounts : {};
  const key = Object.keys(accounts).find((k) => k.toLowerCase() === name.toLowerCase());
  const account = key === undefined ? undefined : accounts[key];
  if (!isRecord(account)) throw new Refusal(`There is no ${name} account in the email config.`);
  const imap = isRecord(account.imap) ? account.imap : undefined;
  const smtpAuth = isRecord(account.smtp) && isRecord(account.smtp.auth) ? account.smtp.auth : {};
  const imapAuth = imap && isRecord(imap.auth) ? imap.auth : {};
  const host = str(imap?.host);
  const user = str(imapAuth.user) ?? str(smtpAuth.user);
  const pass = str(imapAuth.pass) ?? str(smtpAuth.pass);
  if (!imap || imap.enabled !== true || !host || typeof imap.port !== "number" || !user || !pass) {
    throw new Refusal(`The ${name} account has no IMAP settings.`);
  }
  return { name, host, port: imap.port, secure: imap.tls === true, user, pass: await resolvePassword(pass, run) };
}

/**
 * Moves the one INBOX message with this Message-ID to the account's Trash. Never deletes, never expunges,
 * and refuses rather than move anything when the id matches no message or more than one.
 */
export async function trashMessage(req: DeskMailActionRequest, box: Mailbox, inbox = "INBOX"): Promise<DeskWriteResult> {
  const target = await box.trashPath();
  if (!target) throw new Refusal(`The ${req.account} account has no Trash mailbox.`);
  const release = await box.open(inbox);
  try {
    const exact: number[] = [];
    for (const uid of await box.findUids(req.messageId)) {
      const id = await box.messageIdOf(uid);
      if (id !== undefined && bare(id) === req.messageId) exact.push(uid);
    }
    const [uid, ...others] = exact;
    if (uid === undefined) throw new Refusal(`The message is no longer in the ${req.account} ${inbox}.`);
    if (others.length > 0) throw new Refusal(`${exact.length} messages in the ${req.account} ${inbox} share this Message-ID, so none was moved.`);
    if (!(await box.move(uid, target))) throw new Refusal(`The mail server did not move the message to ${target}.`);
    return { id: req.messageId, message: "Moved to Trash." };
  } finally {
    release();
  }
}

/** Picks the Trash mailbox: the one flagged \Trash, else one with a usual name. */
export function pickTrash(boxes: { path: string; name: string; specialUse?: string }[]): string | undefined {
  const flagged = boxes.find((b) => b.specialUse === "\\Trash");
  if (flagged) return flagged.path;
  for (const name of TRASH_NAMES) {
    const named = boxes.find((b) => b.name.toLowerCase() === name.toLowerCase() || b.path.toLowerCase() === name.toLowerCase());
    if (named) return named.path;
  }
  return undefined;
}
