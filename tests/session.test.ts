import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildCompactionCheckpoint,
  buildSlimSession,
  parseSession,
  replacementSessionPath,
  serializeSession,
  type SessionEntry,
} from "../src/session.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * Branch layout used by the behaviour tests.
 *
 *   0 session        7 user     "second question"
 *   1 model_change   8 assistant (thinking + toolCall-2 + text)   <- boundary of c2
 *   2 thinking_level 9 toolResult-2
 *   3 user           10 compaction c2 (firstKeptEntryId = assistant at 8)
 *   4 assistant      11 user     "third question"
 *   5 toolResult-1   12 assistant (thinking + toolCall-3 + text)
 *   6 compaction c1  13 toolResult-3
 */
function fixtureEntries(): SessionEntry[] {
  return [
    { type: "session", version: 3, id: "fixture-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", provider: "openai-codex", modelId: "gpt-test" },
    { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-01-01T00:00:01.500Z", thinkingLevel: "high" },
    { type: "message", id: "u1", parentId: "t1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "first question", timestamp: 1 } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old reasoning", thinkingSignature: "sig" },
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
          { type: "text", text: "old answer" },
        ],
        stopReason: "toolUse",
        responseId: "response-1",
      },
    },
    { type: "message", id: "r1", parentId: "a1", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "old output" }] } },
    { type: "compaction", id: "c1", parentId: "r1", timestamp: "2026-01-01T00:00:05.000Z", summary: "older summary", firstKeptEntryId: "u1", tokensBefore: 10 },
    { type: "message", id: "u2", parentId: "c1", timestamp: "2026-01-01T00:00:06.000Z", message: { role: "user", content: "second question", timestamp: 2 } },
    {
      type: "message",
      id: "a2",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:07.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "recent reasoning", thinkingSignature: "sig" },
          { type: "toolCall", id: "call-2", name: "read", arguments: {} },
          { type: "text", text: "recent answer" },
        ],
        stopReason: "toolUse",
      },
    },
    { type: "message", id: "r2", parentId: "a2", timestamp: "2026-01-01T00:00:08.000Z", message: { role: "toolResult", toolCallId: "call-2", content: [{ type: "text", text: "recent output" }] } },
    { type: "compaction", id: "c2", parentId: "r2", timestamp: "2026-01-01T00:00:09.000Z", summary: "newest summary", firstKeptEntryId: "a2", tokensBefore: 20 },
    { type: "message", id: "u3", parentId: "c2", timestamp: "2026-01-01T00:00:10.000Z", message: { role: "user", content: "third question", timestamp: 3 } },
    {
      type: "message",
      id: "a3",
      parentId: "u3",
      timestamp: "2026-01-01T00:00:11.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "latest reasoning" },
          { type: "toolCall", id: "call-3", name: "bash", arguments: { command: "true" } },
          { type: "text", text: "latest answer" },
        ],
        stopReason: "toolUse",
      },
    },
    { type: "message", id: "r3", parentId: "a3", timestamp: "2026-01-01T00:00:12.000Z", message: { role: "toolResult", toolCallId: "call-3", content: [{ type: "text", text: "latest output" }] } },
  ];
}

function fixtureText(entries = fixtureEntries()): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function parse(entries = fixtureEntries()) {
  return parseSession(Buffer.from(fixtureText(entries)), "fixture.jsonl");
}

function contents(entries: SessionEntry[]): string[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "message") return [entry.type];
    const value = entry.message?.role === "user" ? entry.message.content : entry.message?.content.map((block: { type: string }) => block.type).join("+");
    return [`${entry.message?.role}: ${value}`];
  });
}

describe("session surgery", () => {
  test("automatic checkpoint drops everything the model cannot see and keeps the rest unchanged", () => {
    const parsed = parse();
    const checkpoint = buildCompactionCheckpoint(parsed);
    const rebuilt = parseSession(serializeSession(checkpoint), "checkpoint.jsonl");

    // Everything before the newest compaction's first kept entry is gone, together with the older compaction.
    expect(contents(rebuilt.entries)).toEqual([
      "model_change",
      "thinking_level_change",
      "assistant: thinking+toolCall+text",
      "toolResult: text",
      "compaction",
      "user: third question",
      "assistant: thinking+toolCall+text",
      "toolResult: text",
    ]);
    expect(rebuilt.entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
    expect(rebuilt.entries.find((entry) => entry.type === "compaction")?.summary).toBe("newest summary");
    expect(JSON.stringify(rebuilt.entries)).not.toContain("first question");
    expect(JSON.stringify(rebuilt.entries)).not.toContain("older summary");
    expect(rebuilt.entries.every((entry, index) => entry.parentId === (index === 0 ? null : rebuilt.entries[index - 1].id))).toBe(true);
  });

  test("automatic checkpoint leaves the context Pi sends to the model untouched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-session-surgery-context-"));
    temporaryDirectories.push(directory);
    const originalPath = join(directory, "original.jsonl");
    const checkpointPath = join(directory, "checkpoint.jsonl");
    const parsed = parse();

    await writeFile(originalPath, parsed.raw);
    await writeFile(checkpointPath, serializeSession(buildCompactionCheckpoint(parsed)));

    expect(SessionManager.open(checkpointPath).buildSessionContext()).toEqual(
      SessionManager.open(originalPath).buildSessionContext(),
    );
  });

  test("manual surgery cuts tool history and keeps the newest compaction", () => {
    const parsed = parse();
    const slim = buildSlimSession(parsed);
    const rebuilt = parseSession(serializeSession(slim), "slim.jsonl");

    expect(contents(rebuilt.entries)).toEqual([
      "model_change",
      "thinking_level_change",
      "user: first question",
      "assistant: thinking+text",
      "user: second question",
      "assistant: thinking+text",
      "compaction",
      "user: third question",
      "assistant: thinking+text",
    ]);
    expect(rebuilt.entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
    expect(JSON.stringify(rebuilt.entries)).not.toContain("call-1");
    expect(JSON.stringify(rebuilt.entries)).not.toContain("toolResult");
    expect(rebuilt.entries.every((entry, index) => entry.parentId === (index === 0 ? null : rebuilt.entries[index - 1].id))).toBe(true);
  });

  test("keeps the compaction boundary valid after cutting referenced entries", () => {
    const entries = fixtureEntries();
    const compaction = entries.find((entry) => entry.id === "c2")!;
    compaction.firstKeptEntryId = "r2";
    const rebuilt = parseSession(serializeSession(buildCompactionCheckpoint(parse(entries))), "checkpoint.jsonl");
    const kept = rebuilt.entries.find((entry) => entry.type === "compaction");

    expect(kept?.firstKeptEntryId).toBe(rebuilt.entries.find((entry) => entry.message?.role === "toolResult")?.id);
  });

  test("keeps a materialized compaction tail as the retained context", () => {
    const entries = fixtureEntries();
    const compaction = entries.find((entry) => entry.id === "c2")!;
    delete compaction.firstKeptEntryId;
    compaction.retainedTail = [
      { role: "user", content: "tail question", timestamp: 4 },
      { role: "assistant", content: [{ type: "toolCall", id: "tail-call", name: "read", arguments: {} }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "tail-call", content: [{ type: "text", text: "tail output" }] },
    ];

    const checkpoint = buildCompactionCheckpoint(parse(entries));
    expect(checkpoint.entries.find((entry) => entry.type === "compaction")?.retainedTail).toEqual(compaction.retainedTail);

    const slim = buildSlimSession(parse(entries));
    expect(slim.entries.find((entry) => entry.type === "compaction")?.retainedTail).toEqual([
      { role: "user", content: "tail question", timestamp: 4 },
    ]);
  });

  test("refuses to build a checkpoint without a usable compaction", () => {
    const entries: SessionEntry[] = [
      { type: "session", version: 3, id: "fixture-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi", timestamp: 1 } },
    ];
    expect(() => buildCompactionCheckpoint(parse(entries))).toThrow(/no compaction/i);

    const broken = fixtureEntries();
    broken.find((entry) => entry.id === "c2")!.firstKeptEntryId = "missing";
    expect(() => buildCompactionCheckpoint(parse(broken))).toThrow(/first kept entry/i);
  });

  test("replaces the previous rewrite suffix instead of stacking it", () => {
    const original = join("/sessions", "2026-09-09T07-06-23-904Z_01a084fd-3d20-71ae-a6a2-b29ea76c3679.jsonl");
    let path = replacementSessionPath(original);
    for (let round = 0; round < 50; round += 1) path = replacementSessionPath(path);

    const name = basename(path);
    expect(name.split("surgery-")).toHaveLength(2);
    expect(name.startsWith("2026-09-09T07-06-23-904Z_01a084fd-3d20-71ae-a6a2-b29ea76c3679.surgery-")).toBe(true);
    expect(Buffer.byteLength(name)).toBeLessThan(255);

    // A legacy restored name is rebuilt from its base too.
    const legacy = join("/sessions", "2026-09-09T07-06-23-904Z_01a084fd-3d20-71ae-a6a2-b29ea76c3679.restored-2026-09-09T08-38-37-218Z-4625df.jsonl");
    expect(basename(replacementSessionPath(legacy))).toContain("2026-09-09T07-06-23-904Z_01a084fd-3d20-71ae-a6a2-b29ea76c3679.surgery-");
  });

  test("keeps overlong session names within the file name limit", () => {
    const original = join("/sessions", `${"a".repeat(300)}.jsonl`);
    const name = basename(replacementSessionPath(original));

    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(180);
    expect(name.endsWith(".jsonl")).toBe(true);
  });
});
