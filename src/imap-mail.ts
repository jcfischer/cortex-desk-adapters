import type { DeskSourceMail } from "./contract";

export interface StructureNode {
  part?: string;
  type: string;
  disposition?: string;
  childNodes?: StructureNode[];
}

export interface ListedEnvelope {
  messageId?: string;
  subject?: string;
  date?: Date;
  from?: { name?: string; address?: string }[];
}

export function textPart(node: StructureNode | undefined): string | null {
  if (!node) return null;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) {
      const found = textPart(child);
      if (found) return found;
    }
    return null;
  }
  if (node.type.toLowerCase() !== "text/plain" || node.disposition?.toLowerCase() === "attachment") return null;
  return node.part ?? "1";
}

const GREETING = /^(hi|hello|hey|dear|hallo|liebe[rs]?|guten tag|bonjour|salut)\b[^.!?]{0,40}[,!]?$/i;

export function firstParagraph(text: string, max = 400): string | undefined {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.split("\n").filter((l) => !l.startsWith(">")).join(" ").replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0 && !GREETING.test(p));
  const first = paragraphs[0];
  if (!first) return undefined;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

const bare = (id: string): string => id.trim().replace(/^<|>$/g, "");

export function toDeskMail(envelope: ListedEnvelope, account: string, paragraph: string | undefined, fallbackDate: Date): DeskSourceMail | null {
  const sender = envelope.from?.[0];
  const address = sender?.address?.trim().toLowerCase();
  const id = envelope.messageId ? bare(envelope.messageId) : "";
  if (!address || !id) return null;
  const name = sender?.name?.trim();
  return {
    kind: "mail",
    id,
    from: name ? { name, address } : { address },
    subject: envelope.subject?.trim() || "(no subject)",
    receivedAt: (envelope.date ?? fallbackDate).toISOString(),
    unread: true,
    ...(paragraph ? { firstParagraph: paragraph } : {}),
    account,
  };
}
