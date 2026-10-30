#!/usr/bin/env bun
/**
 * desk-goal: a Desk writer that adds a draft Soma goal from `{ "kind": "goal", "fields": { "wording" } }` on stdin.
 * Usage: desk-goal [--soma soma]
 */
import { parseArgs } from "node:util";
import { readRequest, runWriter, spawnRunner, writeGoal } from "../src/writers";

const { values } = parseArgs({
  options: {
    soma: { type: "string", default: "soma" },
  },
});

await runWriter((text) => writeGoal(readRequest(text, "goal"), { soma: values.soma ?? "soma", run: spawnRunner }));
