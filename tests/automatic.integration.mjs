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

for (const [mode, behavior] of [
  ["manual", "trims manual compaction without waiting for another agent run"],
  ["continue", "preserves an immediate continuation before switching"],
  ["race", "retries a changing snapshot and preserves concurrent extension entries"],
]) {
  test(behavior, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-surgery-integration-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({
      compaction: { enabled: false, keepRecentTokens: 1500 },
    }));
    await writeFile(join(cwd, "history.txt"), "Verified planning evidence and next implementation step.\n".repeat(500));

    const result = await new PiIntegrationTest({
      testName: "automatic-" + mode,
      cwd,
      artifactsDir: artifacts,
      extensions: [fixture],
      tools: ["read", "write"],
      rawMode: false,
      isolateUserResources: false,
      piCommand: process.env.PI_SURGERY_TEST_PI ?? "pi",
      environment: { PI_CODING_AGENT_DIR: join(cwd, "agent"), SURGERY_PROBE_MODE: mode },
      timeoutMs: 10000,
      conversation: [
        call("history", "read", { path: "history.txt" }),
        assistantMessage([text("Planning finished.")]),
        assistantMessage([text("Preserve the plan and implement the next step.")]),
        ...(mode === "manual" ? [] : [
          call("result", "write", { path: "result.txt", content: "done" }),
          assistantMessage([text("Implementation finished.")]),
        ]),
        assistantMessage([text("Verification finished.")]),
      ],
    }).run("Read history.txt and finish planning.");

    const observations = (await readFile(join(cwd, "surgery-probe.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(observations.filter((entry) => entry.event === "command").length, mode === "race" ? 2 : 1);
    assert.deepEqual(observations.filter((entry) => entry.event === "switch"), [
      { event: "switch", idle: true, pending: false },
    ]);
    assert.equal(observations.some((entry) => entry.event === "notify" && entry.level === "error"), false);
    assert.equal(observations.some((entry) => entry.event === "command-end" && entry.sourceRemoved), true);
    const resumed = observations.find((entry) => entry.event === "resumed");
    assert.ok(resumed.types.includes("compaction"));
    if (mode !== "manual") {
      assert.ok(resumed.types.includes("probe-continuation"));
      assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "done");
    }
    if (mode === "race") {
      assert.ok(resumed.heartbeats.length > 0);
      assert.ok(resumed.heartbeats.every((data) => data.value === 42));
    }
    // Pi prints its own "Resumed session" status when the switch resolves, so the trim report
    // must arrive afterwards and say what really happened.
    const switchEnd = observations.findIndex((entry) => entry.event === "switch-end");
    const report = observations.findIndex((entry) =>
      entry.event === "notify" && typeof entry.message === "string"
      && entry.message.includes("the session file was replaced"));
    assert.ok(switchEnd >= 0, "the probe recorded the switch completing");
    assert.ok(report > switchEnd, "the trim report is delivered after the switch completes");
    assert.equal(observations[report].level, "info");
    assert.match(observations[report].message, /[\d.]+ (?:B|KB|MB) → [\d.]+ (?:B|KB|MB)/);
    assert.equal(result.exitCode, 0);
  });
}
