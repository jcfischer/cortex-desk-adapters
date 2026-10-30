import { expect, it } from "bun:test";
import { appleMailUrl, firstParagraph, parseFrom, toDeskMail } from "../src/mail";

it("parses a display name and address, lower-casing the address", () => {
  expect(parseFrom("Ada Lovelace <Ada@Example.org>")).toEqual({ name: "Ada Lovelace", address: "ada@example.org" });
  expect(parseFrom('"Finance & Controlling" <fc@example.ch>')).toEqual({ name: "Finance & Controlling", address: "fc@example.ch" });
  expect(parseFrom("bare@example.ch")).toEqual({ address: "bare@example.ch" });
});

it("builds an Apple Mail link from the Message-ID", () => {
  expect(appleMailUrl("<abc.123@mail.example>")).toBe("message://%3Cabc.123%40mail.example%3E");
  expect(appleMailUrl("abc.123@mail.example")).toBe("message://%3Cabc.123%40mail.example%3E");
});

it("takes the first paragraph after the headers, skipping a greeting", () => {
  const out = ["━━━━", "Subject: Agenda", "From: x <x@y>", "━━━━", "", "Hi Ada,", "", "Could you confirm the agenda", "for Monday?", "", "Thanks"].join("\n");
  expect(firstParagraph(out)).toBe("Could you confirm the agenda for Monday?");
});

it("caps a long paragraph at 400 characters", () => {
  const out = `━━\nh\n━━\n\n${"word ".repeat(200)}`;
  expect(firstParagraph(out)?.length).toBe(398);
});

it("maps a listed message to a Desk mail item", () => {
  const item = toDeskMail({ uid: 1, messageId: "<m1@x>", from: "A <a@x.ch>", subject: "", date: "2026-10-30T14:28:39.000Z", flags: [] }, "work", "Body");
  expect(item).toEqual({ kind: "mail", id: "m1@x", from: { name: "A", address: "a@x.ch" }, subject: "(no subject)", receivedAt: "2026-10-30T14:28:39.000Z", unread: true, firstParagraph: "Body", url: "message://%3Cm1%40x%3E", account: "work" });
});
