import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeskGoalFields, DeskTaskFields, DeskWriteKind, DeskWriteResult } from "./contract";

/** A refusal: its message is one plain sentence, shown to the person as the last line of stderr. */
export class Refusal extends Error {}

/** Runs argv without a shell. Injected so tests never reach soma, GitHub or the goal records. */
export type Runner = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const spawnRunner: Runner = async (argv) => {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The writer input's fields, refused unless it is valid JSON of the expected kind. */
export function readRequest(text: string, kind: DeskWriteKind): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Refusal("The request is not valid JSON.");
  }
  if (!isRecord(body) || !isRecord(body.fields)) throw new Refusal("The request has no fields.");
  if (body.kind !== kind) throw new Refusal(`This writer handles ${kind} requests, not ${JSON.stringify(body.kind)}.`);
  return body.fields;
}

/** A single-line text field; soma reads a value that starts with "--" as a flag, so that is refused too. */
function line(fields: Record<string, unknown>, name: string, max: number): string {
  const v = fields[name];
  if (typeof v !== "string" || !v.trim()) throw new Refusal(`The ${name} is missing.`);
  const t = v.trim();
  if (/[\r\n]/.test(t)) throw new Refusal(`The ${name} must be a single line.`);
  if (t.startsWith("--")) throw new Refusal(`The ${name} must not start with "--".`);
  if (t.length > max) throw new Refusal(`The ${name} is longer than ${max} characters.`);
  return t;
}

export const TASK_LABEL = "desk:principal-intake";

export function readRequestId(text: string): string {
  const body: unknown = JSON.parse(text);
  const id = isRecord(body) ? body.requestId : undefined;
  if (typeof id !== "string" || !/^[\w-]{8,64}$/.test(id)) throw new Refusal("The request has no request id, so a retry could file the task twice.");
  return id;
}

export const onceMarker = (requestId: string): string => `<!-- desk:request ${requestId} -->`;

export function goalFields(fields: Record<string, unknown>): DeskGoalFields {
  return { wording: line(fields, "wording", 500) };
}

export function taskFields(fields: Record<string, unknown>): DeskTaskFields {
  const title = line(fields, "title", 200);
  const map = line(fields, "map", 200);
  const details = fields.details;
  if (details !== undefined && typeof details !== "string") throw new Refusal("The details must be text.");
  return { title, map, ...(details?.trim() ? { details: details.trim() } : {}) };
}

/** `soma goal add` prints the new goal's id (G<n>) on a line of its own; the goal starts as a draft. */
export function goalIdFrom(stdout: string): string | undefined {
  return stdout.split("\n").map((l) => l.trim()).find((l) => /^G\d+$/.test(l));
}

/** The last non-empty line of a failed command's stderr, for the refusal sentence. */
const lastLine = (text: string): string => text.trim().split("\n").at(-1)?.trim() ?? "";

export async function writeGoal(fields: Record<string, unknown>, opts: { soma: string; run: Runner }): Promise<DeskWriteResult> {
  const { wording } = goalFields(fields);
  const out = await opts.run([opts.soma, "goal", "add", "--wording", wording]);
  if (out.code !== 0) throw new Refusal(`soma could not add the goal: ${lastLine(out.stderr) || `exit ${out.code}`}`);
  const id = goalIdFrom(out.stdout);
  if (!id) throw new Refusal("soma added a goal but printed no goal id.");
  return { id, message: `Added goal ${id} as a draft: "${wording}".` };
}

/** "Plan the Q1 offsite!" → "desk-plan-the-q1-offsite", at most 48 characters, cut at a dash. */
export function checkpointSlug(title: string, max = 48): string {
  const kebab = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let slug = `desk-${kebab || "task"}`;
  if (slug.length > max) {
    slug = slug.slice(0, max);
    const cut = slug.lastIndexOf("-");
    if (cut > "desk-".length) slug = slug.slice(0, cut);
  }
  return slug.replace(/-+$/, "");
}

/** The node body: the question an orienteer node carries, plus where it came from. */
export function taskBody(fields: DeskTaskFields, now: Date): string {
  return [
    "## Question",
    "",
    fields.details ?? fields.title,
    "",
    `Filed from the Cortex Desk on ${now.toISOString().slice(0, 10)}.`,
    "",
  ].join("\n");
}

/**
 * The map as `soma graph add` takes it. `owner/name#N` gets an explicit github.com `--repo`, so the
 * store does not depend on the directory Cortex runs the writer from; a qualified ref names its own.
 */
export function mapTarget(map: string): { target: string; repo?: string } {
  if (/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(map)) return { target: map, repo: `github:github.com/${map.split("#")[0]}` };
  if (/^(github|gitlab):[\w.-]+\/[\w./-]+#[1-9]\d*$/.test(map)) return { target: map };
  throw new Refusal(`"${map}" is not a map ref like owner/name#123.`);
}

/** `soma graph add --json` prints `{ repo, node, parent, blockedBy }`; on github.com repo is owner/name, node the issue number. */
export function createdNode(stdout: string): DeskWriteResult & { existing: boolean } {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Refusal("soma filed the task but its output was not JSON.");
  }
  if (!isRecord(body) || typeof body.node !== "string" || typeof body.repo !== "string") throw new Refusal("soma filed the task but printed no node id.");
  const { repo, node } = body;
  const existing = body.existing === true;
  if (!/^\d+$/.test(node)) return { id: node, existing };
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return { id: `${repo}#${node}`, url: `https://github.com/${repo}/issues/${node}`, existing };
  const gh = /^github:([\w.-]+)\/(.+)$/.exec(repo);
  if (gh) return { id: `${repo}#${node}`, url: `https://${gh[1]}/${gh[2]}/issues/${node}`, existing };
  return { id: `${repo}#${node}`, existing };
}

/** With --json, a node created but left unattached is reported as JSON on stderr with `attached: false`. */
function partialNode(stderr: string): string | undefined {
  try {
    const body: unknown = JSON.parse(stderr);
    return isRecord(body) && body.attached === false && typeof body.node === "string" ? body.node : undefined;
  } catch {
    return undefined;
  }
}

export interface TaskOptions {
  soma: string;
  run: Runner;
  /** Allowed map refs; empty allows any. */
  maps: string[];
  autonomy: string;
  kind: string;
  requestId: string;
  now?: Date;
}

export async function writeTask(raw: Record<string, unknown>, opts: TaskOptions): Promise<DeskWriteResult> {
  const fields = taskFields(raw);
  if (opts.maps.length > 0 && !opts.maps.includes(fields.map)) throw new Refusal(`The map ${fields.map} is not one this writer may file to.`);
  if (!["auto", "propose", "approve"].includes(opts.autonomy)) throw new Refusal(`The autonomy ${opts.autonomy} is not auto, propose or approve.`);
  const { target, repo } = mapTarget(fields.map);
  const dir = await mkdtemp(join(tmpdir(), "desk-task-"));
  try {
    const bodyFile = join(dir, "body.md");
    await writeFile(bodyFile, taskBody(fields, opts.now ?? new Date()), { mode: 0o600 });
    const argv = [
      opts.soma, "graph", "add", target,
      "--title", fields.title,
      "--autonomy", opts.autonomy,
      "--checkpoint", checkpointSlug(fields.title),
      "--kind", opts.kind,
      "--label", TASK_LABEL,
      "--once", onceMarker(opts.requestId),
      "--body-file", bodyFile,
      ...(repo ? ["--repo", repo] : []),
      "--json",
    ];
    const out = await opts.run(argv);
    if (out.code !== 0) {
      const partial = partialNode(out.stderr);
      if (partial) throw new Refusal(`soma created node ${partial} but could not attach it to ${fields.map}; finish it with soma graph link.`);
      throw new Refusal(`soma could not file the task: ${lastLine(out.stderr) || `exit ${out.code}`}`);
    }
    const { existing, ...created } = createdNode(out.stdout);
    const message = existing ? `"${fields.title}" was already filed as ${created.id}; nothing new was filed.` : `Filed "${fields.title}" as ${created.id} on ${fields.map}.`;
    return { ...created, message };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Shared bin plumbing: read stdin, write, print the result or the refusal sentence. */
export async function runWriter(write: (text: string) => Promise<DeskWriteResult>): Promise<never> {
  try {
    const result = await write(await new Response(Bun.stdin.stream()).text());
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (error) {
    const sentence = error instanceof Refusal ? error.message : `The writer failed: ${(error as Error).message}`;
    process.stderr.write(`${sentence.replace(/\s*\n\s*/g, " ")}\n`);
    process.exit(1);
  }
}
