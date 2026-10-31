import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { Runner } from "../src/run";
import { checkpointSlug, createdNode, goalIdFrom, goalWithWording, readRequest, Refusal, requireRequestId, writeGoal, writeTask } from "../src/writers";

type Answer = { code?: number; stdout?: string; stderr?: string };

/** A fake runner that records argv and answers like soma would; a function answers per call. */
function fake(answer: Answer | ((argv: string[]) => Answer), onRun?: (argv: string[]) => void) {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    onRun?.(argv);
    const a = typeof answer === "function" ? answer(argv) : answer;
    return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { run, calls };
}

/** soma for goals: `goal list --wording` prints `listed`, `goal add` prints `added`. */
const goalSoma = (listed: string, added: Answer = { stdout: "G9\n" }) => (argv: string[]): Answer => (argv[2] === "list" ? { stdout: listed } : added);

it("refuses a request of another kind, or one that is not JSON", () => {
  expect(() => readRequest('{"kind":"calendar","fields":{}}', "goal")).toThrow(Refusal);
  expect(() => readRequest("nope", "goal")).toThrow("not valid JSON");
  expect(readRequest('{"kind":"goal","fields":{"wording":"x"}}', "goal")).toEqual({ kind: "goal", fields: { wording: "x" } });
  expect(readRequest('{"kind":"goal","fields":{},"requestId":"req-00001"}', "goal").requestId).toBe("req-00001");
  expect(() => readRequest('{"kind":"goal","fields":{},"requestId":"short"}', "goal")).toThrow("request id");
});

it("reads the goal id soma goal add prints", () => {
  expect(goalIdFrom("G9\n")).toBe("G9");
  expect(goalIdFrom("warning: x\nG12\n")).toBe("G12");
  expect(goalIdFrom("done\n")).toBeUndefined();
});

const listed = [
  "G5\tactive\tsupports: [M0]\tsensor: -\tPublish a post a week",
  "G8\tdraft\tsupports: []\tsensor: -\tShip the Desk command bar ",
].join("\n");

it("reads goal ids and wordings from soma goal list --wording", () => {
  expect(goalWithWording(listed, "Publish a post a week")).toBe("G5");
  expect(goalWithWording(listed, "Ship the Desk command bar")).toBe("G8");
  expect(goalWithWording(listed, "Publish a post")).toBeUndefined();
  expect(goalWithWording("G5\tactive\tsupports: [M0]\tsensor: -", "x")).toBeUndefined();
  expect(goalWithWording("", "x")).toBeUndefined();
  expect(goalWithWording("G3\tdropped\tsupports: []\tsensor: -\tRun twice a week", "Run twice a week")).toBeUndefined();
  expect(goalWithWording("G4\tachieved\tsupports: []\tsensor: -\tRun twice a week", "Run twice a week")).toBeUndefined();
});

it("returns the goal that already has the wording, and adds nothing", async () => {
  const { run, calls } = fake(goalSoma(listed));
  const result = await writeGoal({ wording: "Ship the Desk command bar" }, { soma: "soma", run });
  expect(calls).toEqual([["soma", "goal", "list", "--wording"]]);
  expect(result).toEqual({ id: "G8", message: 'Goal G8 already says "Ship the Desk command bar"; nothing new was added.' });
});

it("refuses when soma cannot list the goals, and adds nothing", async () => {
  const { run, calls } = fake({ code: 1, stderr: "goals dir missing\n" });
  await expect(writeGoal({ wording: "x" }, { soma: "soma", run })).rejects.toThrow("soma could not list the goals: goals dir missing");
  expect(calls.length).toBe(1);
});

it("adds a goal through soma and reports it as a draft", async () => {
  const { run, calls } = fake(goalSoma(listed));
  const result = await writeGoal({ wording: "Ship the Desk command bar v2" }, { soma: "/x/soma", run });
  expect(calls).toEqual([["/x/soma", "goal", "list", "--wording"], ["/x/soma", "goal", "add", "--wording", "Ship the Desk command bar v2"]]);
  expect(result).toEqual({ id: "G9", message: 'Added goal G9 as a draft: "Ship the Desk command bar v2".' });
});

it("refuses a goal wording soma would reject, and runs nothing", async () => {
  const { run, calls } = fake({ stdout: "G9\n" });
  await expect(writeGoal({ wording: "two\nlines" }, { soma: "soma", run })).rejects.toThrow("single line");
  await expect(writeGoal({ wording: "--accept x" }, { soma: "soma", run })).rejects.toThrow('"--"');
  await expect(writeGoal({}, { soma: "soma", run })).rejects.toThrow("wording is missing");
  expect(calls).toEqual([]);
});

it("passes soma's own last stderr line on when goal add fails", async () => {
  const { run } = fake(goalSoma("", { code: 1, stderr: "trace\nwording must be a non-empty single line\n" }));
  await expect(writeGoal({ wording: "x" }, { soma: "soma", run })).rejects.toThrow("soma could not add the goal: wording must be a non-empty single line");
});

it("derives a bounded checkpoint slug from the title", () => {
  expect(checkpointSlug("Plan the Q1 offsite!")).toBe("desk-plan-the-q1-offsite");
  expect(checkpointSlug("Zürich café opening")).toBe("desk-zurich-cafe-opening");
  expect(checkpointSlug("!!!")).toBe("desk-task");
  const long = checkpointSlug("Investigate whether the calendar adapter should split multi-day events");
  expect(long.length).toBeLessThanOrEqual(48);
  expect(long).toBe("desk-investigate-whether-the-calendar-adapter");
});

it("reads the node and its issue URL from soma graph add --json", () => {
  expect(createdNode(JSON.stringify({ repo: "the-metafactory/cortex", node: "2801", parent: "the-metafactory/cortex#2770", blockedBy: [] })))
    .toEqual({ id: "the-metafactory/cortex#2801", url: "https://github.com/the-metafactory/cortex/issues/2801", existing: false });
  expect(createdNode(JSON.stringify({ repo: "github:ghe.example/org/repo", node: "5", parent: "x" })))
    .toEqual({ id: "github:ghe.example/org/repo#5", url: "https://ghe.example/org/repo/issues/5", existing: false });
  expect(createdNode(JSON.stringify({ repo: "gitlab:gitlab.example/g/p", node: "g/p#7" }))).toEqual({ id: "g/p#7", existing: false });
});

const created = JSON.stringify({ repo: "the-metafactory/cortex", node: "2801", parent: "the-metafactory/cortex#2770", blockedBy: [] }, null, 2);

it("files a task under its map with the configured autonomy, kind and label", async () => {
  let body = "";
  const { run, calls } = fake({ stdout: created }, (argv) => {
    body = readFileSync(argv[argv.indexOf("--body-file") + 1] ?? "", "utf8");
  });
  const result = await writeTask(
    { title: "Compare EventKit write paths", details: "Which span do recurring events need?", map: "the-metafactory/cortex#2770" },
    { soma: "soma", run, maps: ["the-metafactory/cortex#2770"], autonomy: "approve", kind: "research", requestId: "req-00001", now: new Date("2026-10-30T10:00:00Z") },
  );
  const argv = calls[0] ?? [];
  expect(argv.slice(0, 4)).toEqual(["soma", "graph", "add", "the-metafactory/cortex#2770"]);
  expect(argv).toContain("--json");
  const flag = (name: string) => argv[argv.indexOf(name) + 1];
  expect(flag("--title")).toBe("Compare EventKit write paths");
  expect(flag("--autonomy")).toBe("approve");
  expect(flag("--kind")).toBe("research");
  expect(flag("--label")).toBe("desk:principal-intake");
  expect(flag("--once")).toBe("<!-- desk:request req-00001 -->");
  expect(flag("--checkpoint")).toBe("desk-compare-eventkit-write-paths");
  expect(flag("--repo")).toBe("github:github.com/the-metafactory/cortex");
  expect(body).toBe("## Question\n\nWhich span do recurring events need?\n\nFiled from the Cortex Desk on 2026-10-30.\n");
  expect(result).toEqual({
    id: "the-metafactory/cortex#2801",
    url: "https://github.com/the-metafactory/cortex/issues/2801",
    message: 'Filed "Compare EventKit write paths" as the-metafactory/cortex#2801 on the-metafactory/cortex#2770.',
  });
});

it("refuses a map off the allow-list and runs nothing", async () => {
  const { run, calls } = fake({ stdout: created });
  const opts = { soma: "soma", run, maps: ["the-metafactory/cortex#2770"], autonomy: "approve", kind: "research", requestId: "req-00001" };
  await expect(writeTask({ title: "x", map: "evil/repo#1" }, opts)).rejects.toThrow("not one this writer may file to");
  await expect(writeTask({ title: "x", map: "#5" }, { ...opts, maps: [] })).rejects.toThrow("not a map ref");
  await expect(writeTask({ title: "x", map: "a/b#1" }, { ...opts, maps: [], autonomy: "yolo" })).rejects.toThrow("autonomy");
  expect(calls).toEqual([]);
});

it("reports a node soma created but could not attach", async () => {
  const { run } = fake({ code: 1, stderr: JSON.stringify({ repo: "a/b", node: "9", parent: "a/b#1", attached: false }, null, 2) });
  await expect(writeTask({ title: "x", map: "a/b#1" }, { soma: "soma", run, maps: [], autonomy: "approve", kind: "research", requestId: "req-00001" }))
    .rejects.toThrow("soma created node 9 but could not attach it to a/b#1");
});

it("reports a task soma found already filed for the same request, and files nothing new", async () => {
  const { run } = fake({ stdout: JSON.stringify({ repo: "the-metafactory/cortex", node: "2801", parent: "x", blockedBy: [], existing: true }) });
  const result = await writeTask(
    { title: "Look", map: "the-metafactory/cortex#2770" },
    { soma: "soma", run, maps: [], autonomy: "approve", kind: "research", requestId: "req-00001" },
  );
  expect(result.message).toBe('"Look" was already filed as the-metafactory/cortex#2801; nothing new was filed.');
});

it("refuses a task request without a request id", () => {
  expect(() => requireRequestId(readRequest('{"kind":"task","fields":{}}', "task"))).toThrow("request id");
  expect(requireRequestId(readRequest('{"kind":"task","fields":{},"requestId":"req-00001"}', "task"))).toBe("req-00001");
});
