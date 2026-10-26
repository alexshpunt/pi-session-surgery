import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

test("trims the live session right after a compaction and keeps it working", async (t) => {
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
    environment: { PI_CODING_AGENT_DIR: join(cwd, "agent") },
    timeoutMs: 20000,
    conversation: [
      call("history", "read", { path: "history.txt" }),
      assistantMessage([text("Planning finished.")]),
      assistantMessage([text("Summary of the planning work.")]),
      call("result", "write", { path: "result.txt", content: "done" }),
      assistantMessage([text("Implementation finished.")]),
    ],
  }).run("Read history.txt and finish planning.");

  const observations = (await readFile(join(cwd, "surgery-probe.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  const compacted = observations.find((entry) => entry.event === "compacted");
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
  assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "done");
  assert.ok(observations.some((entry) => entry.event === "result-written"));
  assert.equal(result.exitCode, 0);
});
