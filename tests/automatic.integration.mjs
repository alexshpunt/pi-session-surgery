import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PiIntegrationTest, assistantMessage, getToolCallNames, getToolExecution, text, toolCall } from "pi-coding-agent-test";

const fixture = fileURLToPath(new URL("./fixtures/automatic-probe.ts", import.meta.url));
const artifacts = fileURLToPath(new URL("../.tmp/test-runs", import.meta.url));
const call = (id, name, args) => assistantMessage([
  toolCall({ id, name, arguments: args }),
], { stopReason: "toolUse" });

for (const scenario of ["normal", "orphan", "broken-checkpoint"]) {
  const recoverOrphan = scenario === "orphan";
  const brokenCheckpoint = scenario === "broken-checkpoint";
  test(brokenCheckpoint
    ? "disables unsafe trimming once and continues tools after a broken checkpoint"
    : recoverOrphan
      ? "recovers hidden orphan history and continues tools across repeated live compactions"
      : "awaits repeated live trims and keeps the session working", async (t) => {
    const rounds = brokenCheckpoint ? 2 : 4;
    const cwd = await mkdtemp(join(tmpdir(), "pi-surgery-integration-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({
      compaction: { enabled: false, keepRecentTokens: 1500 },
    }));
    await writeFile(join(cwd, "history.txt"), "Verified planning evidence and next implementation step.\n".repeat(500));

    const result = await new PiIntegrationTest({
      testName: brokenCheckpoint ? "automatic-broken-checkpoint" : recoverOrphan ? "automatic-orphan-recovery" : "automatic-in-place",
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
        PI_SURGERY_TEST_ORPHAN: recoverOrphan ? "1" : "0",
        PI_SURGERY_TEST_BROKEN: brokenCheckpoint ? "1" : "0",
      },
      timeoutMs: 20000,
      conversation: [
        ...Array.from({ length: rounds }, (_, round) => [
          call(`history-${round}`, "read", { path: "history.txt" }),
          assistantMessage([text(`Planning round ${round} finished.`)]),
          assistantMessage([text(`Summary of planning round ${round}.`)]),
          // Later split-turn compactions summarize prior history and the new turn prefix.
          ...(round > 0 && !brokenCheckpoint ? [assistantMessage([text(`Turn prefix for round ${round}.`)])] : []),
        ]).flat(),
        call("result", "write", { path: "result.txt", content: "done" }),
        assistantMessage([text("Implementation finished.")]),
      ],
    }).run("Read history.txt and finish planning.");

    const observations = (await readFile(join(cwd, "surgery-probe.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    await writeFile(join(result.artifacts.directory, "surgery-observations.json"), JSON.stringify(observations, null, 2) + "\n");
    const before = observations.filter((entry) => entry.event === "before-trim");
    const after = observations.filter((entry) => entry.event === "compacted");
    assert.equal(before.length, rounds, "all compactions were observed before trimming");
    assert.equal(after.length, rounds, "all requested compactions completed");
    assert.deepEqual(before.map((entry) => entry.compactions), brokenCheckpoint ? [1, 2] : [1, 2, 2, 2]);
    assert.deepEqual(after.map((entry) => entry.compactions), brokenCheckpoint ? [1, 2] : [1, 1, 1, 1]);
    assert.equal(observations.filter((entry) => entry.event === "notification" && entry.level === "error").length, Number(brokenCheckpoint));
    for (let round = 0; round < rounds; round += 1) {
      if (brokenCheckpoint) assert.equal(after[round].size, before[round].size, `round ${round} left unsafe history unchanged`);
      else assert.ok(after[round].size < before[round].size, `round ${round} shrank its session file`);
      assert.equal(after[round].contextUnchanged, true, `round ${round} preserved Pi context`);
      assert.equal(after[round].leaf, before[round].leaf, `round ${round} preserved its live leaf`);
      assert.equal(after[round].orphans, 0, `round ${round} left no missing parents`);
    }
    assert.deepEqual(before.map((entry) => entry.orphans), Array.from({ length: rounds }, (_, round) => Number(recoverOrphan && round === 0)));
    assert.equal(observations.filter((entry) => entry.event === "orphan-injected").length, Number(recoverOrphan));
    if (recoverOrphan) assert.equal(observations.find((entry) => entry.event === "orphan-injected").contextUnchanged, true);

    const shutdown = observations.find((entry) => entry.event === "shutdown");
    assert.ok(before[0]?.file, "the probe saw a compaction in a persisted session");
    assert.ok(shutdown, "the run reported the session at shutdown");
    assert.equal(observations.some((entry) => entry.event === "resumed"), false);
    for (const entry of observations.filter((item) => typeof item.file === "string")) {
      assert.equal(entry.file, before[0].file, `${entry.event} keeps the same session file`);
      assert.equal(entry.sessionId, before[0].sessionId, `${entry.event} keeps the same session identity`);
    }
    if (!brokenCheckpoint) assert.ok(shutdown.size < before[0].size, `session file shrank: ${before[0].size} -> ${shutdown.size}`);

    const entries = (await readFile(join(cwd, "session-final.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const ids = new Set(entries.slice(1).map((entry) => entry.id));
    assert.equal(ids.size, entries.length - 1, "entry IDs remain unique");
    for (const entry of entries.slice(1)) {
      assert.ok(entry.parentId === null || ids.has(entry.parentId), `${entry.id} has an existing parent`);
    }
    assert.equal(entries.filter((entry) => entry.type === "compaction").length, brokenCheckpoint ? rounds : 1);
    assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "done");
    assert.ok(observations.some((entry) => entry.event === "result-written"));
    assert.deepEqual(getToolCallNames(result), [...Array(rounds).fill("read"), "write"]);
    for (const id of [...Array.from({ length: rounds }, (_, round) => `history-${round}`), "result"]) {
      assert.equal(getToolExecution(result, id).isError, false, `${id} executed successfully`);
    }
    assert.equal(result.exitCode, 0);
  });
}
