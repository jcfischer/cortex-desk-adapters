import { expect, it } from "bun:test";
import { linksOf } from "../src/links";

it("keeps links whose whole visible text is a host or URL, with their http(s) target", () => {
  const html = `<p>Log in at <a class="x" href="https://login.evil.example/?a=1&amp;b=2"><b>www.bank&#46;example</b></a>,
    <a href='https://bank.example/help'>https://bank.example/help</a> or <a href=https://t.example/x>click here</a>.
    <a href="https://t.example/y">see bank.example for details</a> <a href="mailto:a@bank.example">a@bank.example</a>
    <a href="javascript:void(0)">bank.example</a> <A HREF="https://login.evil.example/?a=1&amp;b=2">www.bank.example</A></p>`;
  expect(linksOf(html)).toEqual([
    { text: "www.bank.example", href: "https://login.evil.example/?a=1&b=2" },
    { text: "https://bank.example/help", href: "https://bank.example/help" },
  ]);
});

it("keeps at most 20 links and nothing from text without anchors", () => {
  const many = Array.from({ length: 30 }, (_, i) => `<a href="https://t.example/${i}">site${i}.example</a>`).join("");
  expect(linksOf(many)).toHaveLength(20);
  expect(linksOf("plain text with bank.example")).toEqual([]);
});

it("survives entities outside Unicode and a body of unclosed anchors", () => {
  expect(linksOf('<a href="https://evil.example/">bank.example&#x110000;&#99999999999;</a>')).toEqual([]);
  expect(linksOf('<a href="https://evil.example/">&#x62;ank.example</a>')).toEqual([{ text: "bank.example", href: "https://evil.example/" }]);
  const started = performance.now();
  expect(linksOf(`${"<a href='https://x.example'>".repeat(20_000)}x`)).toEqual([]);
  expect(performance.now() - started).toBeLessThan(2000);
});
