import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import {
  appendSurgeryMetadata,
  buildCompactionCheckpoint,
  buildSlimSession,
  createBackup,
  latestSurgeryMetadata,
  parseSession,
  replacementSessionPath,
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
          { type: "thinking", thinking: "keep me", thinkingSignature: "sig", redacted: true },
          { type: "toolCall", id: "call", name: "read", arguments: {} },
          { type: "text", text: "keep this", textSignature: "text-sig" },
        ],
        stopReason: "toolUse",
        rawStopReason: "tool_calls",
        responseId: "response-1",
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

    expect(assistant?.message).toMatchObject({ stopReason: "stop" });
    expect(assistant?.message).not.toHaveProperty("rawStopReason");
    expect(assistant?.message).not.toHaveProperty("responseId");

    expect(Object.keys(assistant?.message ?? {}).sort()).toEqual(["content", "role", "stopReason"]);
    expect(assistant?.message.content[0]).toEqual({ type: "thinking", thinking: "keep me" });
    expect(assistant?.message.content[1]).toEqual({ type: "text", text: "keep this" });

    expect(parsedSlim.entries.some((entry) => entry.type === "custom_message")).toBe(false);
    expect(latestSurgeryMetadata(parsedSlim)?.backupManifest).toBe("/tmp/manifest.json");
    expect(parsedSlim.entries.some((entry) => entry.message?.role === "toolResult")).toBe(false);
    expect(parsedSlim.entries.find((entry) => entry.type === "compaction")?.firstKeptEntryId).toBe(assistant?.id);
    expect(parsedSlim.entries.every((entry, index) => entry.parentId === (index === 0 ? null : parsedSlim.entries[index - 1].id))).toBe(true);
  });

  test("removes tool history and provider replay metadata from materialized compaction tails", () => {
    const entries = fixtureEntries();
    const compaction = entries.find((entry) => entry.type === "compaction")!;
    delete compaction.firstKeptEntryId;
    compaction.retainedTail = [
      { role: "user", content: "keep user", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "keep thought", thinkingSignature: "sig" },
          { type: "toolCall", id: "tail-call", name: "bash", arguments: { command: "true" } },
          { type: "text", text: "keep answer", textSignature: "text-sig" },
        ],
        stopReason: "toolUse",
        responseId: "tail-response",
      },
      { role: "toolResult", toolCallId: "tail-call", toolName: "bash", content: [], isError: false },
    ];

    const parsed = parseSession(Buffer.from(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`), "fixture.jsonl");
    const slim = buildSlimSession(parsed);
    const tail = slim.entries.find((entry) => entry.type === "compaction")?.retainedTail;

    expect(tail).toEqual([
      { role: "user", content: "keep user", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "keep thought" },
          { type: "text", text: "keep answer" },
        ],
        stopReason: "stop",
      },
    ]);
  });

  test("restarts from the latest compacted checkpoint without changing its context", async () => {
    const entries = fixtureEntries();
    entries.splice(1, 0, {
      type: "thinking_level_change",
      id: "t1",
      parentId: "m1",
      timestamp: "2026-01-01T00:00:01.500Z",
      thinkingLevel: "high",
    });
    entries[3].parentId = "t1";

    const originalRaw = Buffer.from(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const parsed = parseSession(originalRaw, "fixture.jsonl");
    const checkpoint = buildCompactionCheckpoint(parsed);
    const checkpointRaw = serializeSession(checkpoint);
    const parsedCheckpoint = parseSession(checkpointRaw, "checkpoint.jsonl");
    const context = parsedCheckpoint.entries;

    expect(context.some((entry) => entry.id === "u1" || entry.message?.content === "hello")).toBe(false);
    expect(context.find((entry) => entry.type === "model_change")).toMatchObject({ provider: "openai-codex", modelId: "gpt-test" });
    expect(context.find((entry) => entry.type === "thinking_level_change")).toMatchObject({ thinkingLevel: "high" });
    expect(context.find((entry) => entry.type === "compaction")?.summary).toBe("keep summary");
    expect(context.find((entry) => entry.type === "compaction")?.firstKeptEntryId).toBe(
      context.find((entry) => entry.message?.role === "assistant")?.id,
    );
    expect(context.find((entry) => entry.message?.role === "assistant")?.message.content).toContainEqual({
      type: "toolCall",
      id: "call",
      name: "read",
      arguments: {},
    });
    expect(context.find((entry) => entry.message?.role === "toolResult")?.message.content).toEqual([
      { type: "text", text: "remove me" },
    ]);
    expect(context.some((entry) => entry.type === "custom_message")).toBe(true);
    expect(context.every((entry, index) => entry.parentId === (index === 0 ? null : context[index - 1].id))).toBe(true);

    const directory = await mkdtemp(join(tmpdir(), "pi-session-surgery-context-"));
    temporaryDirectories.push(directory);
    const originalPath = join(directory, "original.jsonl");
    const checkpointPath = join(directory, "checkpoint.jsonl");
    await writeFile(originalPath, originalRaw);
    await writeFile(checkpointPath, checkpointRaw);
    expect(SessionManager.open(checkpointPath).buildSessionContext()).toEqual(
      SessionManager.open(originalPath).buildSessionContext(),
    );
  });

  test("keeps a materialized compacted tail as a self-contained checkpoint", () => {
    const entries = fixtureEntries();
    const compaction = entries.find((entry) => entry.type === "compaction")!;
    delete compaction.firstKeptEntryId;
    compaction.retainedTail = [
      { role: "user", content: "recent request", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "recent-call", name: "read", arguments: { path: "README.md" } }],
        stopReason: "toolUse",
      },
      { role: "toolResult", toolCallId: "recent-call", toolName: "read", content: [], isError: false },
    ];

    const parsed = parseSession(Buffer.from(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`), "fixture.jsonl");
    const checkpoint = buildCompactionCheckpoint(parsed);
    const rebuiltCompaction = checkpoint.entries.find((entry) => entry.type === "compaction");

    expect(checkpoint.entries.some((entry) => entry.message?.content === "hello")).toBe(false);
    expect(rebuiltCompaction?.retainedTail).toEqual(compaction.retainedTail);
  });

  test("refuses checkpoint trimming when the compacted tail cannot be recovered", () => {
    const entries = fixtureEntries();
    const compaction = entries.find((entry) => entry.type === "compaction")!;
    compaction.firstKeptEntryId = "missing";
    const parsed = parseSession(Buffer.from(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`), "fixture.jsonl");

    expect(() => buildCompactionCheckpoint(parsed)).toThrow(/first kept entry/i);
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
    if (process.platform !== "win32") {
      expect((await stat(backup.backupPath)).mode & 0o777).toBe(0o600);
    }
  });

  test("replaces the previous rewrite suffix instead of stacking it", () => {
    const original = join("/sessions", "2026-09-09T07-06-23-904Z_01a084fd-3d20-71ae-a6a2-b29ea76c3679.jsonl");
    let path = replacementSessionPath(original, "surgery");
    for (let round = 0; round < 50; round += 1) path = replacementSessionPath(path, "surgery");

    const name = basename(path);
    expect(name.split("surgery-")).toHaveLength(2);
    expect(name.startsWith("2026-09-09T07-06-23-904Z_01a084fd-3d20-71ae-a6a2-b29ea76c3679.surgery-")).toBe(true);
    expect(Buffer.byteLength(name)).toBeLessThan(255);
    expect(basename(replacementSessionPath(path, "restored"))).toContain(".restored-");
    expect(basename(replacementSessionPath(path, "restored"))).not.toContain("surgery-");
  });

  test("keeps overlong session names within the file name limit", () => {
    const original = join("/sessions", `${"a".repeat(300)}.jsonl`);
    const name = basename(replacementSessionPath(original, "surgery"));

    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(180);
    expect(name.endsWith(".jsonl")).toBe(true);
  });
});
