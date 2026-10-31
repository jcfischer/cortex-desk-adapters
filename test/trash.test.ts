import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imapAccount, pickTrash, readTrashRequest, resolvePassword, trashMessage, type Mailbox } from "../src/trash";
import type { Runner } from "../src/run";
import { Refusal } from "../src/writers";

const REQ = { action: "trash" as const, account: "work", messageId: "abc@gitlab.example" };

function fakeBox(messages: Record<number, string>, trash: string | null = "Trash", canMove = true) {
  const moved: { uid: number; target: string }[] = [];
  const opened: string[] = [];
  let released = 0;
  const box: Mailbox = {
    canMove: () => canMove,
    open: async (path) => {
      opened.push(path);
      return () => { released += 1; };
    },
    findUids: async (id) => Object.entries(messages).filter(([, m]) => m.includes(id)).map(([uid]) => Number(uid)),
    messageIdOf: async (uid) => messages[uid],
    trashPath: async () => trash ?? undefined,
    move: async (uid, target) => {
      moved.push({ uid, target });
      return true;
    },
  };
  return { box, moved, opened, released: () => released };
}

it("moves exactly the one INBOX message with that Message-ID to Trash", async () => {
  const f = fakeBox({ 7: "<abc@gitlab.example>", 8: "<other@gitlab.example>", 9: "<xabc@gitlab.example.net>" });
  expect(await trashMessage(REQ, f.box)).toEqual({ id: "abc@gitlab.example", message: "Moved to Trash." });
  expect(f.moved).toEqual([{ uid: 7, target: "Trash" }]);
  expect(f.opened).toEqual(["INBOX"]);
  expect(f.released()).toBe(1);
});

it("refuses in one line when the message is gone, and moves nothing", async () => {
  const f = fakeBox({ 8: "<other@gitlab.example>" });
  await expect(trashMessage(REQ, f.box)).rejects.toThrow(new Refusal("The message is no longer in the work INBOX."));
  expect(f.moved).toEqual([]);
});

it("refuses when two messages share the Message-ID, or the account has no Trash", async () => {
  const twice = fakeBox({ 1: "<abc@gitlab.example>", 2: "abc@gitlab.example" });
  await expect(trashMessage(REQ, twice.box)).rejects.toThrow("2 messages in the work INBOX share this Message-ID, so none was moved.");
  expect(twice.moved).toEqual([]);
  const noTrash = fakeBox({ 1: "<abc@gitlab.example>" }, null);
  await expect(trashMessage(REQ, noTrash.box)).rejects.toThrow("The work account has no Trash mailbox.");
  expect(noTrash.moved).toEqual([]);
});

it("refuses a server without IMAP MOVE before it opens the mailbox, so nothing is expunged", async () => {
  const f = fakeBox({ 7: "<abc@gitlab.example>" }, "Trash", false);
  await expect(trashMessage(REQ, f.box)).rejects.toThrow("The work mail server cannot move messages (no IMAP MOVE), so nothing was moved.");
  expect(f.moved).toEqual([]);
  expect(f.opened).toEqual([]);
});

it("reads only a trash request with an account and a Message-ID", () => {
  expect(readTrashRequest(JSON.stringify({ action: "trash", account: "work", messageId: "<abc@gitlab.example>" }))).toEqual(REQ);
  expect(() => readTrashRequest(JSON.stringify({ action: "delete", account: "work", messageId: "a@b" }))).toThrow("This command only moves mail to Trash.");
  expect(() => readTrashRequest(JSON.stringify({ action: "trash", account: "../x", messageId: "a@b" }))).toThrow("The request names no valid account.");
  expect(() => readTrashRequest(JSON.stringify({ action: "trash", account: "work", messageId: "a b" }))).toThrow("The request has no valid Message-ID.");
  expect(() => readTrashRequest("not json")).toThrow("The request is not valid JSON.");
});

it("picks the mailbox flagged \\Trash, else a usual name", () => {
  expect(pickTrash([{ path: "INBOX", name: "INBOX" }, { path: "Papierkorb", name: "Papierkorb", specialUse: "\\Trash" }, { path: "Trash", name: "Trash" }])).toBe("Papierkorb");
  expect(pickTrash([{ path: "INBOX", name: "INBOX" }, { path: "Deleted Items", name: "Deleted Items" }])).toBe("Deleted Items");
  expect(pickTrash([{ path: "INBOX", name: "INBOX" }])).toBeUndefined();
});

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desk-mail-trash-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const keychain = (pass: string, code = 0) => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    return { code, stdout: `${pass}\n`, stderr: "" };
  };
  return { run, calls };
};

it("reads the account from the email config, case-insensitively, with the password from the keychain", async () => {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ accounts: { Work: { smtp: { auth: { user: "ada", pass: "keychain:mail-work" } }, imap: { enabled: true, host: "imap.example", port: 993, tls: true } } } }));
  const k = keychain("s3cret");
  expect(await imapAccount("work", k.run, path)).toEqual({ name: "work", host: "imap.example", port: 993, secure: true, user: "ada", pass: "s3cret" });
  expect(k.calls).toEqual([["security", "find-generic-password", "-s", "mail-work", "-w"]]);
});

it("refuses an unknown account, one without IMAP, and a missing keychain item", async () => {
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ accounts: { work: { smtp: { auth: { user: "ada", pass: "x" } } } } }));
  await expect(imapAccount("home", keychain("x").run, path)).rejects.toThrow("There is no home account in the email config.");
  await expect(imapAccount("work", keychain("x").run, path)).rejects.toThrow("The work account has no IMAP settings.");
  await expect(resolvePassword("keychain:nope", keychain("", 44).run)).rejects.toThrow("The mail password could not be read from the keychain.");
  expect(await resolvePassword("env:MAIL_PASS", keychain("x").run, { MAIL_PASS: "p" })).toBe("p");
});
