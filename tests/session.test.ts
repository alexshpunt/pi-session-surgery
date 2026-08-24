import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import {
  appendSurgeryMetadata,
  buildSlimSession,
  createBackup,
  latestSurgeryMetadata,
  parseSession,
  restoreBackup,
  serializeSession,
  type SessionEntry,
} from "../src/session.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fixtureEntries(): SessionEntry[] {
  return [
    {
      type: "session",
      version: 3,
      id: "fixture-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp",
    },
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", provider: "openai-codex", modelId: "gpt-test" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "hello", timestamp: 1 } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "keep me", thinkingSignature: "sig" },
          { type: "toolCall", id: "call", name: "read", arguments: {} },
          { type: "text", text: "keep this" },
        ],
        stopReason: "toolUse",
      },
    },
    { type: "message", id: "r1", parentId: "a1", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "remove me" }], isError: false } },
    { type: "compaction", id: "c1", parentId: "r1", timestamp: "2026-01-01T00:00:05.000Z", summary: "keep summary", firstKeptEntryId: "a1", tokensBefore: 10 },
    { type: "custom_message", id: "x1", parentId: "c1", timestamp: "2026-01-01T00:00:06.000Z", customType: "mesh", content: "remove me", display: true },
    {
      type: "custom",
      id: "s1",
      parentId: "x1",
      timestamp: "2026-01-01T00:00:07.000Z",
      customType: "pi-session-surgery",
      data: {
        version: 1,
        operation: "slim",
        backupManifest: "/tmp/manifest.json",
        backupSha256: "abc123",
        sourceSessionId: "source-session",
        createdAt: "2026-01-01T00:00:07.000Z",
      },
    },
  ];
}

function fixtureText(): string {
  return `${fixtureEntries().map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

describe("session surgery", () => {
  test("keeps conversation blocks and remaps the compaction reference", () => {
    const parsed = parseSession(Buffer.from(fixtureText()), "fixture.jsonl");
    const slim = buildSlimSession(parsed);
    const parsedSlim = parseSession(serializeSession(slim), "slim.jsonl");
    const assistant = parsedSlim.entries.find((entry) => entry.message?.role === "assistant");

    expect(assistant?.message.content.map((block: { type: string }) => block.type)).toEqual(["thinking", "text"]);

    expect(parsedSlim.entries.some((entry) => entry.type === "custom_message")).toBe(false);
    expect(latestSurgeryMetadata(parsedSlim)?.backupManifest).toBe("/tmp/manifest.json");
    expect(parsedSlim.entries.some((entry) => entry.message?.role === "toolResult")).toBe(false);
    expect(parsedSlim.entries.find((entry) => entry.type === "compaction")?.firstKeptEntryId).toBe(assistant?.id);
    expect(parsedSlim.entries.every((entry, index) => entry.parentId === (index === 0 ? null : parsedSlim.entries[index - 1].id))).toBe(true);
  });

  test("appends metadata for the immediate parent backup", () => {
    const parsed = parseSession(Buffer.from(fixtureText()), "fixture.jsonl");
    const slim = appendSurgeryMetadata(buildSlimSession(parsed), {
      version: 1,
      operation: "slim",
      backupManifest: "/tmp/new-manifest.json",
      backupSha256: "def456",
      sourceSessionId: "fixture-session",
      createdAt: "2026-01-01T00:00:08.000Z",
    });
    const parsedSlim = parseSession(serializeSession(slim), "slim.jsonl");

    expect(latestSurgeryMetadata(parsedSlim)?.backupManifest).toBe("/tmp/new-manifest.json");
    expect(parsedSlim.entries.at(-1)?.customType).toBe("pi-session-surgery");
  });

  test("creates an immutable backup and restores its exact bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-session-surgery-test-"));
    temporaryDirectories.push(directory);
    const sourcePath = join(directory, "source.jsonl");
    const targetPath = join(directory, "restored.jsonl");
    const source = Buffer.from(fixtureText());
    await writeFile(sourcePath, source, { mode: 0o600 });
    const parsed = parseSession(source, sourcePath);

    const backup = await createBackup(sourcePath, parsed, join(directory, "backups"));
    await restoreBackup(backup.manifestPath, targetPath);

    expect(await readFile(backup.backupPath)).toEqual(source);
    expect(await readFile(targetPath)).toEqual(source);
    expect((await stat(backup.backupPath)).mode & 0o777).toBe(0o600);
  });
});
