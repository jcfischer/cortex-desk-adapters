import { describe, expect, test } from "bun:test";
import { deflateRawSync, gzipSync } from "node:zlib";
import { dmarcReport, MAX_XML_BYTES, parseXml, readDmarcRequest, readReport, ReportRefusal, reportAttachment, type ReportMailbox } from "../src/dmarc";
import { attachmentsOf } from "../src/imap";
import { Refusal } from "../src/writers";

interface Row {
  ip: string;
  count: number;
  spf: "pass" | "fail";
  dkim: "pass" | "fail";
  disposition?: string;
  from?: string;
}

const report = (rows: Row[], domain = "example.org"): string => `<?xml version="1.0" encoding="UTF-8" ?>
<feedback xmlns="urn:ietf:params:xml:ns:dmarc-2.0">
  <report_metadata>
    <org_name>Example Reporter &amp; Co</org_name>
    <email>dmarc@reporter.example.net</email>
    <report_id>r-123</report_id>
    <date_range><begin>1792627200</begin><end>1792713599</end></date_range>
  </report_metadata>
  <policy_published><domain>${domain}</domain><p>quarantine</p></policy_published>
  ${rows.map((r) => `<record>
    <row>
      <source_ip>${r.ip}</source_ip>
      <count>${r.count}</count>
      <policy_evaluated><disposition>${r.disposition ?? "none"}</disposition><dkim>${r.dkim}</dkim><spf>${r.spf}</spf></policy_evaluated>
    </row>
    <identifiers><header_from>${r.from ?? domain}</header_from></identifiers>
    <auth_results><spf><domain>${domain}</domain><result>${r.spf}</result></spf></auth_results>
  </record>`).join("\n")}
</feedback>`;

const PASSING = report([{ ip: "192.0.2.10", count: 12, spf: "pass", dkim: "pass" }]);
const SPF_FAIL = report([
  { ip: "192.0.2.10", count: 5, spf: "pass", dkim: "pass" },
  { ip: "198.51.100.7", count: 3, spf: "fail", dkim: "pass" },
]);
const DKIM_FAIL = report([
  { ip: "192.0.2.10", count: 2, spf: "pass", dkim: "pass" },
  { ip: "203.0.113.9", count: 4, spf: "fail", dkim: "fail", disposition: "quarantine" },
  { ip: "203.0.113.8", count: 1, spf: "pass", dkim: "fail" },
]);

const crc32 = (b: Buffer): number => Bun.hash.crc32(b);

function zip(name: string, content: Buffer, method: 0 | 8 = 8, declared?: number): Buffer {
  const data = method === 8 ? deflateRawSync(content) : content;
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc32(content), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(declared ?? content.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc32(content), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(declared ?? content.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE(0, 42);
  const cdStart = local.length + fileName.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + fileName.length, 12);
  end.writeUInt32LE(cdStart, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ReportRefusal);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("readReport", () => {
  test("a passing report (gzip) counts every message and lists no failing source", () => {
    const r = readReport(gzipSync(PASSING), "gzip", "m1@example.org");
    expect(r.org).toBe("Example Reporter & Co");
    expect(r.policyDomain).toBe("example.org");
    expect(r.begin).toBe("2026-10-22T00:00:00.000Z");
    expect(r.domains).toEqual([{ domain: "example.org", messages: 12, spf: { pass: 12, fail: 0 }, dkim: { pass: 12, fail: 0 }, dmarcFail: 0, disposition: { none: 12, quarantine: 0, reject: 0 }, failing: [] }]);
  });

  test("an SPF failure (zip) names the failing source; DKIM still passes, so DMARC does not fail", () => {
    const [d] = readReport(zip("reporter.example.net!example.org!1!2.xml", Buffer.from(SPF_FAIL)), "zip", "m2").domains;
    expect(d?.spf).toEqual({ pass: 5, fail: 3 });
    expect(d?.dkim).toEqual({ pass: 8, fail: 0 });
    expect(d?.dmarcFail).toBe(0);
    expect(d?.failing).toEqual([{ ip: "198.51.100.7", count: 3, spfFail: 3, dkimFail: 0, dmarcFail: 0 }]);
  });

  test("a DKIM failure (stored zip, plain XML) ranks failing sources by count and counts DMARC failures", () => {
    for (const r of [readReport(zip("r.xml", Buffer.from(DKIM_FAIL), 0), "zip", "m3"), readReport(Buffer.from(DKIM_FAIL), "xml", "m3")]) {
      const [d] = r.domains;
      expect(d?.dkim).toEqual({ pass: 2, fail: 5 });
      expect(d?.dmarcFail).toBe(4);
      expect(d?.disposition.quarantine).toBe(4);
      expect(d?.failing.map((s) => [s.ip, s.count, s.dmarcFail])).toEqual([["203.0.113.9", 4, 4], ["203.0.113.8", 1, 0]]);
    }
  });

  test("records are counted per header-from domain", () => {
    const r = readReport(Buffer.from(report([{ ip: "192.0.2.1", count: 1, spf: "pass", dkim: "pass" }, { ip: "192.0.2.2", count: 2, spf: "fail", dkim: "fail", from: "news.example.org" }])), "xml", "m4");
    expect(r.domains.map((d) => [d.domain, d.messages, d.dmarcFail])).toEqual([["example.org", 1, 0], ["news.example.org", 2, 2]]);
  });

  test("malformed attachments are refused with a reason", () => {
    expect(refusal(() => readReport(Buffer.from("<feedback><report_metadata></feedback>"), "xml", "x"))).toContain("not well-formed");
    expect(refusal(() => readReport(Buffer.from("<html><body>hi</body></html>"), "xml", "x"))).toContain("not a DMARC aggregate report");
    expect(refusal(() => readReport(Buffer.from("not gzip at all"), "gzip", "x"))).toContain("damaged");
    expect(refusal(() => readReport(Buffer.from("PK nothing"), "zip", "x"))).toContain("central directory");
    expect(refusal(() => readReport(Buffer.from(report([{ ip: "192.0.2.1", count: -1, spf: "pass", dkim: "pass" }])), "xml", "x"))).toContain("valid count");
  });

  test("a DOCTYPE or entity declaration is refused, never expanded", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE feedback [<!ENTITY x SYSTEM "file:///etc/passwd">]><feedback>&x;</feedback>`;
    expect(refusal(() => readReport(Buffer.from(xxe), "xml", "x"))).toContain("DOCTYPE");
  });

  test("zip bomb guard: a gzip or zip that unpacks past the cap is refused", () => {
    const huge = Buffer.alloc(MAX_XML_BYTES + 1024, 0x20);
    const bomb = gzipSync(huge);
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(refusal(() => readReport(bomb, "gzip", "x"))).toContain("unpacks to more than");
    expect(refusal(() => readReport(zip("r.xml", huge), "zip", "x"))).toContain("unpacks to more than");
    expect(refusal(() => readReport(zip("r.xml", Buffer.from(PASSING), 8, 1), "zip", "x"))).toContain("not the size it declares");
  });

  test("an attachment over the size cap is refused before it is unpacked", () => {
    expect(refusal(() => readReport(Buffer.alloc(2 * 1024 * 1024), "gzip", "x"))).toContain("larger than");
  });
});

describe("parseXml", () => {
  test("decodes the predefined entities and CDATA, ignores comments and namespace prefixes", () => {
    const root = parseXml(`<a:feedback xmlns:a="x"><!-- c --><a:x>1 &lt; 2</a:x><y><![CDATA[a<b]]></y><z/></a:feedback>`);
    expect(root.name).toBe("feedback");
    expect(root.children.map((c) => [c.name, c.text])).toEqual([["x", "1 < 2"], ["y", "a<b"], ["z", ""]]);
  });
});

describe("reportAttachment", () => {
  const part = (type: string, filename = "", size = 900) => ({ part: "2", type, filename, size });
  test("picks the one report part by type or file name", () => {
    expect(reportAttachment([part("text/plain"), part("application/octet-stream", "a!b!1!2.xml.gz")]).packing).toBe("gzip");
    expect(reportAttachment([part("application/zip")]).packing).toBe("zip");
  });
  test("refuses a mail without a report, with two, or with an oversized one", () => {
    expect(refusal(() => reportAttachment([part("text/plain")]))).toContain("no DMARC report attachment");
    expect(refusal(() => reportAttachment([part("application/zip"), part("application/gzip")]))).toContain("2 report attachments");
    expect(refusal(() => reportAttachment([part("application/zip", "", 5 * 1024 * 1024)]))).toContain("larger than");
  });
});

describe("attachmentsOf", () => {
  test("lists the leaves of a body structure with their file names", () => {
    const structure = { childNodes: [{ part: "1", childNodes: [{ part: "1.1", type: "text/plain", size: 58 }] }, { part: "2", type: "application/gzip", size: 772, dispositionParameters: { filename: "a.xml.gz" } }] };
    expect(attachmentsOf(structure)).toEqual([{ part: "1.1", type: "text/plain", filename: "", size: 58 }, { part: "2", type: "application/gzip", filename: "a.xml.gz", size: 772 }]);
    expect(attachmentsOf({ type: "application/zip", size: 10, parameters: { name: "r.zip" } })).toEqual([{ part: "1", type: "application/zip", filename: "r.zip", size: 10 }]);
  });
});

describe("dmarcReport", () => {
  const box = (bytes: Uint8Array): ReportMailbox & { asked: number[] } => {
    const asked: number[] = [];
    return {
      asked,
      attachments: async () => [{ part: "2", type: "application/gzip", filename: "r.xml.gz", size: bytes.length }],
      download: async (_id, _part, max) => {
        asked.push(max);
        return bytes;
      },
    };
  };
  test("reads the attachment of the requested mail with a byte cap", async () => {
    const b = box(gzipSync(SPF_FAIL));
    const r = await dmarcReport(readDmarcRequest(JSON.stringify({ action: "dmarc", account: "personal", messageId: "<m@example.org>" })), b);
    expect(r.id).toBe("m@example.org");
    expect(r.domains[0]?.spf.fail).toBe(3);
    expect(b.asked[0]).toBeGreaterThan(0);
  });
  test("refuses requests that are not a DMARC request (not a ReportRefusal: nothing was read)", () => {
    for (const text of ["{", JSON.stringify({ action: "move", account: "a", messageId: "m" }), JSON.stringify({ action: "dmarc", account: "a b", messageId: "m" })]) {
      expect(() => readDmarcRequest(text)).toThrow(Refusal);
    }
  });
});
