import { expect, it } from "bun:test";
import { parseMailHeaders } from "../src/mail-headers";

it("reads List-Id, unsubscribe, the topmost auth verdicts, Reply-To and In-Reply-To from a folded header block", () => {
  const raw = [
    "List-Id: Weekly stats <stats.example.org>",
    "List-Unsubscribe: <https://example.org/u?x=1>,",
    "  <mailto:unsub@example.org>",
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    "Authentication-Results: mx.example.ch; spf=pass smtp.mailfrom=example.org;",
    "\tdkim=pass header.d=example.org; dmarc=fail (p=none) header.from=example.org",
    "Authentication-Results: other.example; spf=fail",
    "Reply-To: Team <team@example.org>",
    "In-Reply-To: <a1@example.org>",
    "",
  ].join("\r\n");
  expect(parseMailHeaders(raw)).toEqual({
    listId: "Weekly stats <stats.example.org>",
    listUnsubscribe: "<https://example.org/u?x=1>, <mailto:unsub@example.org>",
    listUnsubscribePost: "List-Unsubscribe=One-Click",
    authResults: { spf: "pass", dkim: "pass", dmarc: "fail" },
    replyTo: "Team <team@example.org>",
    inReplyTo: "<a1@example.org>",
  });
});

it("leaves out what it cannot read: unknown verdicts, overlong values, control characters, lines without a name", () => {
  const raw = [
    "Authentication-Results: mx; spf=maybe; dkim=; dmarc=PASS",
    `List-Id: ${"x".repeat(400)}`,
    "Reply-To: a\u0000b@example.org",
    ": no name",
    "garbage without colon",
    "In-Reply-To:   ",
  ].join("\n");
  expect(parseMailHeaders(raw)).toEqual({ authResults: { dmarc: "pass" }, replyTo: "ab@example.org" });
  expect(parseMailHeaders("")).toBeUndefined();
  expect(parseMailHeaders("Authentication-Results: mx; none")).toBeUndefined();
});

it("ignores an ARC chain's comment and reads the verdicts of this hop", () => {
  const raw = "Authentication-Results: mx.google.com; arc=pass (i=1 spf=pass spfdomain=a.example dkim=pass dmarc=pass); spf=softfail smtp.mailfrom=a.example; dkim=fail (bad sig) header.i=@a.example; dmarc=fail (p=REJECT) header.from=a.example";
  expect(parseMailHeaders(raw)?.authResults).toEqual({ spf: "softfail", dkim: "fail", dmarc: "fail" });
});

it("reads verdicts only from a trusted authserv-id when one is given, so a forged topmost header is ignored", () => {
  const raw = [
    "Authentication-Results: forged.example; spf=pass; dkim=pass; dmarc=pass",
    "Authentication-Results: MX.Ours.Example (comment); spf=fail; dmarc=fail",
  ].join("\n");
  expect(parseMailHeaders(raw)?.authResults).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass" });
  expect(parseMailHeaders(raw, ["mx.ours.example"])?.authResults).toEqual({ spf: "fail", dmarc: "fail" });
  expect(parseMailHeaders(raw, ["other.example"])).toBeUndefined();
});
