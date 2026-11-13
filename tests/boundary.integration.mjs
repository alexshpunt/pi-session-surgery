import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PiIntegrationTest, assistantMessage, getToolCallNames, getToolExecution, text, toolCall } from "pi-coding-agent-test";

const fixture = fileURLToPath(new URL("./fixtures/boundary-probe.ts", import.meta.url));
const artifacts = fileURLToPath(new URL("../.tmp/test-runs", import.meta.url));
const call = (id, name, args) => assistantMessage([
  toolCall({ id, name, arguments: args }),
], { stopReason: "toolUse" });

for (const boundary of ["turn_end", "agent_before_settle"]) {
  for (const retainNone of [false, true]) {
    for (const continueRun of [true, false]) {
      test(`trims ${boundary} drafts with ${retainNone ? "no retained tail" : "a retained tail"} ${continueRun ? "before continuation" : "at settlement"}`, async (t) => {
        const rounds = continueRun ? 3 : 1;
        const cwd = await mkdtemp(join(tmpdir(), "pi-surgery-boundary-"));
        t.after(() => rm(cwd, { recursive: true, force: true }));
        await mkdir(join(cwd, ".pi"));
        await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ compaction: { enabled: false } }));
        await writeFile(join(cwd, "history.txt"), "Verified historical evidence covered by the next checkpoint.\n".repeat(500));
        const result = await new PiIntegrationTest({
          testName: `boundary-${boundary}-${retainNone ? "none" : "tail"}-${continueRun ? "continue" : "settle"}`,
          cwd, artifactsDir: artifacts, extensions: [fixture], tools: ["read", "write"],
          rawMode: false, isolateUserResources: false,
          piCommand: process.env.PI_SURGERY_TEST_PI ?? "pi",
          environment: {
            PI_CODING_AGENT_DIR: join(cwd, "agent"),
            PI_SURGERY_TEST_BOUNDARY: boundary,
            PI_SURGERY_TEST_RETAIN_NONE: retainNone ? "1" : "0",
            PI_SURGERY_TEST_CONTINUE: continueRun ? "1" : "0",
            PI_SURGERY_TEST_COMPACTIONS: String(rounds),
          },
          timeoutMs: 30000,
          conversation: [
            ...Array.from({ length: rounds }, (_, round) => [
              call(`history-${round}`, "read", { path: "history.txt" }),
              ...(!continueRun ? [call("result", "write", { path: "result.txt", content: "done" })] : []),
              assistantMessage([text(`Planning round ${round} finished.`)]),
            ]).flat(),
            ...(continueRun ? [
              call("result", "write", { path: "result.txt", content: "done" }),
              assistantMessage([text("Implementation finished.")]),
            ] : []),
          ],
        }).run("Read history.txt, finish planning, then write result.txt containing done.");

        const observations = (await readFile(join(cwd, "boundary-probe.jsonl"), "utf8"))
          .trim().split("\n").map((line) => JSON.parse(line));
        await writeFile(join(result.artifacts.directory, "boundary-observations.json"), JSON.stringify(observations, null, 2) + "\n");
        const before = observations.filter((entry) => entry.event === "before-trim");
        const after = observations.filter((entry) => entry.event === "after-trim");
        assert.equal(observations.filter((entry) => entry.event === "drafted").length, rounds);
        assert.equal(observations.filter((entry) => entry.event === "session-compact").length, 0, "boundary compactions do not emit the traditional event");
        assert.equal(before.length, rounds, "all committed checkpoints were observed");
        assert.equal(after.length, rounds, "all post-boundary hooks completed");
        for (let round = 0; round < rounds; round += 1) {
          assert.ok(after[round].size < before[round].size, `round ${round} shrank its session file`);
          assert.equal(after[round].contextUnchanged, true, `round ${round} preserved Pi context`);
          assert.equal(after[round].leaf, before[round].leaf);
          assert.equal(after[round].file, before[round].file);
          assert.equal(after[round].sessionId, before[round].sessionId);
          assert.equal(after[round].compactions, 1, "older checkpoints were removed");
          assert.equal(after[round].states, round + 1, "all extension state survived");
        }

        const entries = (await readFile(join(cwd, "boundary-session-final.jsonl"), "utf8"))
          .trim().split("\n").map((line) => JSON.parse(line));
        const ids = new Set(entries.slice(1).map((entry) => entry.id));
        assert.equal(ids.size, entries.length - 1);
        for (const entry of entries.slice(1)) assert.ok(entry.parentId === null || ids.has(entry.parentId));
        assert.equal(entries.filter((entry) => entry.type === "compaction").length, 1);
        assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "boundary-state").length, rounds);
        assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "done");
        assert.deepEqual(getToolCallNames(result), [...Array(rounds).fill("read"), "write"]);
        for (const id of [...Array.from({ length: rounds }, (_, round) => `history-${round}`), "result"]) {
          assert.equal(getToolExecution(result, id).isError, false, `${id} executed successfully`);
        }
        assert.equal(result.exitCode, 0);
      });
    }
  }
}
