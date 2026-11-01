import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

const emailConfigPath = (): string => join(homedir(), ".config", "email", "config.json");

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
