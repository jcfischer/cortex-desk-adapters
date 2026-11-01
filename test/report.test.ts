import { describe, expect, it } from "bun:test";
import { readReportRequest, reportDraft, saveReportDraft, type PhishingReportBox } from "../src/report";
import type { Folder } from "../src/move";

const ORIGINAL = new TextEncoder().encode("From: Bank <service@bank.example>\r\nSubject: Verify your account\r\nMessage-ID: <m1@bank.example>\r\n\r\nClick now.\r\n");
const FOLDERS: Folder[] = [{ path: "INBOX", name: "INBOX" }, { path: "Junk", name: "Junk", specialUse: "\\Junk" }, { path: "Entw&APw-rfe", name: "Entwürfe", specialUse: "\\Drafts" }];

function box(where: Record<string, Uint8Array | undefined>, folders: Folder[] = FOLDERS) {
  const appended: { folder: string; content: string; flags: string[] }[] = [];
  const looked: string[] = [];
  const b: PhishingReportBox = {
    folders: async () => folders,
    source: async (folder) => { looked.push(folder); return where[folder]; },
    append: async (folder, content, flags) => { appended.push({ folder, content: new TextDecoder().decode(content), flags }); },
  };
  return { b, appended, looked };
}

describe("the report request", () => {
  it("needs an account, a Message-ID and one report address", () => {
    expect(readReportRequest(JSON.stringify({ action: "report", account: "work", messageId: "<m1@bank.example>", to: " abuse@provider.example " }))).toEqual({ action: "report", account: "work", messageId: "m1@bank.example", to: "abuse@provider.example" });
    expect(() => readReportRequest(JSON.stringify({ action: "report", account: "work", messageId: "m1@bank.example" }))).toThrow("No report address is configured (mc.desk.mail.report.to), so no draft was saved.");
    expect(() => readReportRequest(JSON.stringify({ action: "report", account: "work", messageId: "m1", to: "a@b.example, c@d.example" }))).toThrow("The report address is not one valid email address.");
    expect(() => readReportRequest(JSON.stringify({ action: "draft", account: "work", messageId: "m1", to: "a@b.example" }))).toThrow("This command only saves report drafts.");
  });
});

describe("the report draft", () => {
  it("attaches the original unchanged as message/rfc822 and keeps an ASCII subject", () => {
    const draft = new TextDecoder().decode(reportDraft({ from: "me@own.example", to: "abuse@provider.example", messageId: "m1@bank.example", original: ORIGINAL, boundary: "b1", draftId: "d1@desk.invalid", date: new Date("2026-11-01T09:00:00Z") }));
    expect(draft).toStartWith("From: me@own.example\r\nTo: abuse@provider.example\r\nSubject: Phishing report: Verify your account\r\nDate: Sun, 01 Nov 2026 09:00:00 GMT\r\nMessage-ID: <d1@desk.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"b1\"\r\n");
    expect(draft).toContain("--b1\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename=\"reported-message.eml\"\r\nContent-Transfer-Encoding: 7bit\r\n\r\n" + new TextDecoder().decode(ORIGINAL) + "--b1--\r\n");
  });

  it("refuses a boundary that occurs in the original", () => {
    expect(() => reportDraft({ to: "a@b.example", messageId: "m", original: new TextEncoder().encode("--b1\r\n"), boundary: "b1", draftId: "d", date: new Date() })).toThrow("the boundary occurs in the original message");
  });
});

describe("saving a report draft", () => {
  const req = { action: "report" as const, account: "work", messageId: "m1@bank.example", to: "abuse@provider.example" };

  it("reads the original from INBOX, else Junk, and appends the draft to Drafts without sending", async () => {
    const { b, appended, looked } = box({ Junk: ORIGINAL });
    const result = await saveReportDraft(req, b, { from: "me@own.example", newId: () => "r1", now: () => new Date("2026-11-01T09:00:00Z") });
    expect(looked).toEqual(["INBOX", "Junk"]);
    expect(result).toEqual({ id: "desk-report-r1@desk.invalid", message: "A report draft to abuse@provider.example is in your work Entw&APw-rfe. Send it from there." });
    expect(appended.map((a) => [a.folder, a.flags])).toEqual([["Entw&APw-rfe", ["\\Draft", "\\Seen"]]]);
    expect(appended[0]?.content).toContain("Content-Type: message/rfc822");
  });

  it("refuses when the message is gone or there is no Drafts mailbox, and saves nothing", async () => {
    const gone = box({});
    await expect(saveReportDraft(req, gone.b)).rejects.toThrow("The message is no longer in the work INBOX or Junk, so it was not reported.");
    const noDrafts = box({ INBOX: ORIGINAL }, [{ path: "INBOX", name: "INBOX" }]);
    await expect(saveReportDraft(req, noDrafts.b)).rejects.toThrow("The work account has no Drafts mailbox, so no report was saved.");
    expect([...gone.appended, ...noDrafts.appended]).toEqual([]);
  });
});
