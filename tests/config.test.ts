import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { loadSessionSurgeryConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; agentDir: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-session-surgery-config-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  return { root, agentDir, cwd };
}

test("enables checkpoint surgery after compaction by default", async () => {
  const paths = await workspace();

  expect(loadSessionSurgeryConfig(paths.cwd, paths.agentDir, true)).toEqual({ autoAfterCompaction: true });
});

test("lets a trusted project disable automatic checkpoint surgery", async () => {
  const paths = await workspace();
  await writeFile(join(paths.cwd, ".pi", "session-surgery.json"), '{"autoAfterCompaction":false}\n');

  expect(loadSessionSurgeryConfig(paths.cwd, paths.agentDir, true)).toEqual({ autoAfterCompaction: false });
  expect(loadSessionSurgeryConfig(paths.cwd, paths.agentDir, false)).toEqual({ autoAfterCompaction: true });
});

test("rejects invalid automatic surgery settings instead of guessing", async () => {
  const paths = await workspace();
  await writeFile(join(paths.agentDir, "extensions", "session-surgery.json"), '{"autoAfterCompaction":"yes"}\n');

  expect(() => loadSessionSurgeryConfig(paths.cwd, paths.agentDir, true)).toThrow(/autoAfterCompaction/);
});
