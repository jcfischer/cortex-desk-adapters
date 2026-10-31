import { expect, it } from "bun:test";
import { readDraftRequest, saveDraft } from "../src/draft";
import type { Runner } from "../src/run";
import { Refusal } from "../src/writers";

const REQ = { action: "draft", account: "work", messageId: "<b1@example.org>", to: "boss@example.org", subject: "Re: Budget", body: "Friday works.\n\nJC" };

function fakeEmail(result: { code: number; stdout: string; stderr?: string }) {
  const calls: { argv: string[]; stdin?: string }[] = [];
  const run: Runner = async (argv, stdin) => {
    calls.push({ argv, ...(stdin === undefined ? {} : { stdin }) });
    return { stderr: "", ...result };
  };
  return { run, calls };
}

it("saves the reply in Drafts with email draft create, threaded and with the body on stdin, and never sends", async () => {
  const f = fakeEmail({ code: 0, stdout: JSON.stringify({ success: true, uid: 9, messageId: "<d1@invisible.ch>", account: "work", mailbox: "Drafts" }) });
  const result = await saveDraft(readDraftRequest(JSON.stringify(REQ)), f.run, "/bin/email");
  expect(result).toEqual({ id: "d1@invisible.ch", message: "Draft saved in work Drafts." });
  expect(f.calls).toEqual([{
    argv: ["/bin/email", "draft", "create", "--account=work", "--to=boss@example.org", "--subject=Re: Budget", "--in-reply-to=<b1@example.org>", "--no-markdown", "--output=json"],
    stdin: "Friday works.\n\nJC",
  }]);
  expect(f.calls.flatMap((c) => c.argv)).not.toContain("send");
});

it("refuses in one line with the mail server's reason when the draft is not saved", async () => {
  const f = fakeEmail({ code: 1, stdout: JSON.stringify({ success: false, error: "Drafts mailbox not found\nretry later" }) });
  await expect(saveDraft(readDraftRequest(JSON.stringify(REQ)), f.run)).rejects.toThrow("The work mail server did not save the draft: Drafts mailbox not found retry later");
  const crashed = fakeEmail({ code: 2, stdout: "", stderr: "boot\nerror: unknown account work\n" });
  await expect(saveDraft(readDraftRequest(JSON.stringify(REQ)), crashed.run)).rejects.toThrow("did not save the draft: error: unknown account work");
});

it("refuses a request that is not a valid draft before anything runs", () => {
  const bad = (over: Record<string, unknown>) => () => readDraftRequest(JSON.stringify({ ...REQ, ...over }));
  expect(() => readDraftRequest("nope")).toThrow(Refusal);
  expect(bad({ action: "send" })).toThrow("This command only saves reply drafts.");
  expect(bad({ to: "Boss <boss@example.org>" })).toThrow("no valid recipient");
  expect(bad({ to: "a@example.org,b@example.org" })).toThrow("no valid recipient");
  expect(bad({ subject: "Re: x\nBcc: evil@example.org" })).toThrow("no valid subject");
  expect(bad({ body: "  " })).toThrow("The reply is empty.");
  expect(bad({ account: "../work" })).toThrow("no valid account");
});
