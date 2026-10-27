import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PiIntegrationTest, assistantMessage, text, toolCall } from "pi-coding-agent-test";

const fixture = fileURLToPath(new URL("./fixtures/automatic-probe.ts", import.meta.url));
const artifacts = fileURLToPath(new URL("../.tmp/test-runs", import.meta.url));
const call = (id, name, args) => assistantMessage([
  toolCall({ id, name, arguments: args }),
], { stopReason: "toolUse" });

test("trims repeated live compactions and keeps the session working", async (t) => {
  const rounds = 4;
  const cwd = await mkdtemp(join(tmpdir(), "pi-surgery-integration-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: 1500 },
  }));
  await writeFile(join(cwd, "history.txt"), "Verified planning evidence and next implementation step.\n".repeat(500));

  const result = await new PiIntegrationTest({
    testName: "automatic-in-place",
    cwd,
    artifactsDir: artifacts,
    extensions: [fixture],
    tools: ["read", "write"],
    rawMode: false,
    isolateUserResources: false,
    piCommand: process.env.PI_SURGERY_TEST_PI ?? "pi",
    environment: {
      PI_CODING_AGENT_DIR: join(cwd, "agent"),
      PI_SURGERY_TEST_COMPACTIONS: String(rounds),
    },
    timeoutMs: 20000,
    conversation: [
      ...Array.from({ length: rounds }, (_, round) => [
        call(`history-${round}`, "read", { path: "history.txt" }),
        assistantMessage([text(`Planning round ${round} finished.`)]),
        assistantMessage([text(`Summary of planning round ${round}.`)]),
        // Later split-turn compactions summarize both prior history and the new turn prefix.
        ...(round > 0 ? [assistantMessage([text(`Turn prefix for round ${round}.`)])] : []),
      ]).flat(),
      call("result", "write", { path: "result.txt", content: "done" }),
      assistantMessage([text("Implementation finished.")]),
    ],
  }).run("Read history.txt and finish planning.");

  const observations = (await readFile(join(cwd, "surgery-probe.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  const compactions = observations.filter((entry) => entry.event === "compacted");
  assert.equal(compactions.length, rounds, "all requested compactions completed");
  assert.deepEqual(compactions.map((entry) => entry.compactions), [1, 2, 2, 2], "each previous trim removed older checkpoints");
  const compacted = compactions[0];
  const shutdown = observations.find((entry) => entry.event === "shutdown");
  assert.ok(compacted?.file, "the probe saw a compaction in a persisted session");
  assert.ok(shutdown, "the run reported the session at shutdown");

  // No session switch: no resumed session, no second session file, the same path throughout.
  assert.equal(observations.some((entry) => entry.event === "resumed"), false);
  for (const entry of observations.filter((item) => typeof item.file === "string")) {
    assert.equal(entry.file, compacted.file, `${entry.event} keeps the same session file`);
  }

  // The file the session uses shrank in place, and the session kept running afterwards.
  assert.ok(shutdown.size < compacted.size, `session file shrank: ${compacted.size} -> ${shutdown.size}`);
  const entries = (await readFile(join(cwd, "session-final.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const ids = new Set(entries.slice(1).map((entry) => entry.id));
  assert.equal(ids.size, entries.length - 1, "entry IDs remain unique");
  for (const entry of entries.slice(1)) {
    assert.ok(entry.parentId === null || ids.has(entry.parentId), `${entry.id} has an existing parent`);
  }
  assert.equal(entries.filter((entry) => entry.type === "compaction").length, 1, "only the newest checkpoint remains");
  assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "done");
  assert.ok(observations.some((entry) => entry.event === "result-written"));
  assert.match(result.tuiRenderedOutput, /Compacted session trimmed:/);
  assert.match(result.tuiRenderedOutput, /Implementation finished\./);
  assert.doesNotMatch(result.terminalOutput, /Automatic session surgery failed|Compaction failed/);
  assert.equal(result.exitCode, 0);
});
