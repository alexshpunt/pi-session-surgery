import { describe, expect, test } from "vitest";

import {
  activeBranch,
  buildCompactionCheckpoint,
  buildSlimSession,
  parseSession,
  serializeSession,
  type SessionEntry,
} from "../src/session.js";

const tool = (name: string, description = name) => ({ name, description, parameters: { type: "object", properties: {} } });
const system = (toolsAdded: ReturnType<typeof tool>[], toolsRemoved: string[] = []) => ({
  role: "system", content: "", toolsAdded, toolsRemoved: toolsRemoved.map((name) => ({ name })), timestamp: 1,
});

function fixture(options: { snapshot?: boolean; materialized?: boolean; retainNone?: boolean } = {}): SessionEntry[] {
  const entries: SessionEntry[] = [
    { type: "session", version: 3, id: "tool-state", cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", message: system([tool("read"), tool("bash"), tool("write"), tool("inspect_tui")]) },
    { type: "message", message: system([], ["inspect_tui"]) },
    { type: "message", message: { role: "user", content: "kept question", timestamp: 2 } },
    { type: "message", message: system([tool("read", "updated read"), tool("codemode")], ["write"]) },
    {
      type: "compaction", summary: "summary", firstKeptEntryId: options.retainNone ? "e5" : "e3", tokensBefore: 100,
      ...(options.snapshot === false ? {} : {
        systemMessage: { ...system([tool("read", "updated read"), tool("bash"), tool("codemode")]), sections: { preamble: "Keep this prompt" } },
      }),
      ...(options.materialized ? { retainedTail: [{ role: "user", content: "materialized question", timestamp: 2 }] } : {}),
    },
    { type: "message", message: system([tool("write")], ["codemode"]) },
    { type: "message", message: { role: "user", content: "after compaction", timestamp: 3 } },
  ];
  entries.slice(1).forEach((entry, index) => {
    entry.id = `e${index + 1}`;
    entry.parentId = index === 0 ? null : `e${index}`;
    entry.timestamp = "2026-01-01T00:00:01.000Z";
  });
  return entries;
}

function parse(entries: SessionEntry[]) {
  return parseSession(Buffer.from(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`), "tools.jsonl");
}

// Pi 1.4 resumes tools from branch system messages, not compaction.systemMessage.
function replay(entries: SessionEntry[]) {
  const active = new Map<string, ReturnType<typeof tool>>();
  const mentioned = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message?.role !== "system") continue;
    for (const removed of entry.message.toolsRemoved ?? []) {
      mentioned.add(removed.name);
      active.delete(removed.name);
    }
    for (const added of entry.message.toolsAdded ?? []) {
      mentioned.add(added.name);
      active.set(added.name, added);
    }
  }
  return { active: [...active.values()].sort((a, b) => a.name.localeCompare(b.name)), mentioned: [...mentioned].sort() };
}

describe.each([
  ["automatic", buildCompactionCheckpoint],
  ["manual", buildSlimSession],
] as const)("%s surgery tool state", (_name, build) => {
  test.each([{}, { materialized: true }, { snapshot: false }])("keeps tool declarations and explicit removals across resume: %j", (options) => {
    const original = parse(fixture(options));
    const expected = replay(activeBranch(original));
    const rebuilt = parseSession(serializeSession(build(original)), "rebuilt.jsonl");
    expect(replay(activeBranch(rebuilt))).toEqual(expected);
    expect(replay(rebuilt.entries).active.map((entry) => entry.name)).toEqual(["bash", "read", "write"]);
  });

  test("restores the base loadout even when an earlier surgery already removed system history", () => {
    const entries = fixture().filter((entry, index) => index === 0 || index >= 3);
    entries[1].parentId = null;
    const rebuilt = build(parse(entries));
    expect(replay(rebuilt.entries).active.map((entry) => entry.name)).toEqual(["bash", "read", "write"]);
    expect(replay(rebuilt.entries).active.find((entry) => entry.name === "read")?.description).toBe("updated read");
  });

  test("keeps an enabled extension tool alongside the built-in tools", () => {
    const entries = fixture();
    entries[6].message.toolsRemoved = [];
    const rebuilt = build(parse(entries));
    expect(replay(rebuilt.entries)).toEqual(replay(entries));
    expect(replay(rebuilt.entries).active.map((entry) => entry.name)).toEqual(["bash", "codemode", "read", "write"]);
  });

  test("keeps tools disabled when the compacted loadout is empty", () => {
    const entries = fixture();
    entries[5].systemMessage.toolsAdded = [];
    entries.splice(6);
    const rebuilt = build(parse(entries));
    expect(replay(rebuilt.entries).active).toEqual([]);
    expect(replay(rebuilt.entries).mentioned).toEqual(["bash", "codemode", "inspect_tui", "read", "write"]);
  });

  test("keeps a recoverable older snapshot when the newest compaction has none", () => {
    const entries = fixture();
    entries.push({
      type: "compaction", id: "e8", parentId: "e7", timestamp: "2026-01-01T00:00:02.000Z",
      summary: "later summary", firstKeptEntryId: "e7", tokensBefore: 100,
    });
    const rebuilt = build(parse(entries));
    expect(replay(rebuilt.entries)).toEqual(replay(entries));
    expect(rebuilt.entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
  });

  test("does not copy tool state from an abandoned branch", () => {
    const entries = fixture();
    const leaf = entries.pop()!;
    entries.push({
      type: "message", id: "abandoned", parentId: "e6", timestamp: "2026-01-01T00:00:02.000Z",
      message: system([tool("abandoned-tool")]),
    }, leaf);
    const rebuilt = build(parse(entries));
    expect(replay(rebuilt.entries)).toEqual(replay(entries.filter((entry) => entry.id !== "abandoned")));
  });

  test.each([false, true])("keeps the boundary valid when a folded system delta precedes an older compaction (later message: %s)", (hasLaterMessage) => {
    const entries = fixture().slice(0, 6);
    entries.push(
      { type: "message", id: "e6", parentId: "e5", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "kept after older compaction", timestamp: 2 } },
      { type: "compaction", id: "e7", parentId: "e6", timestamp: "2026-01-01T00:00:03.000Z", summary: "new summary", firstKeptEntryId: "e4", tokensBefore: 100, systemMessage: structuredClone(entries[5].systemMessage) },
    );
    if (hasLaterMessage) entries.push({ type: "message", id: "e8", parentId: "e7", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "user", content: "later message", timestamp: 4 } });
    const rebuilt = build(parse(entries));
    const compaction = rebuilt.entries.find((entry) => entry.type === "compaction")!;
    const boundary = rebuilt.entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
    const keptIndex = rebuilt.entries.findIndex((entry) => entry.message?.content === "kept after older compaction");
    expect(boundary).toBeGreaterThanOrEqual(0);
    expect(boundary).toBeLessThanOrEqual(keptIndex);
  });

  test("does not lose the kept user message when a folded system boundary is followed by a removed tool result", () => {
    const entries = fixture().slice(0, 5);
    entries.push(
      { type: "message", id: "e5", parentId: "e4", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolCallId: "old-call", content: [{ type: "text", text: "old result" }] } },
      { type: "message", id: "e6", parentId: "e5", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: "kept after tool result", timestamp: 3 } },
      { type: "compaction", id: "e7", parentId: "e6", timestamp: "2026-01-01T00:00:04.000Z", summary: "summary", firstKeptEntryId: "e4", tokensBefore: 100, systemMessage: fixture()[5].systemMessage },
    );
    const rebuilt = build(parse(entries));
    const compaction = rebuilt.entries.find((entry) => entry.type === "compaction")!;
    const boundary = rebuilt.entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
    expect(rebuilt.entries.slice(boundary).some((entry) => entry.message?.content === "kept after tool result")).toBe(true);
  });

  test("does not mutate the source and keeps tool state through repeated rewrites", () => {
    const original = parse(fixture());
    const before = structuredClone(original.entries);
    let rewritten = build(original);
    expect(original.entries).toEqual(before);
    const count = rewritten.entries.length;
    for (let round = 0; round < 3; round += 1) {
      rewritten = build(parseSession(serializeSession(rewritten), "again.jsonl"));
      expect(replay(rewritten.entries)).toEqual(replay(before));
      expect(rewritten.entries).toHaveLength(count);
    }
  });
});

test("automatic surgery accepts Pi's retain-none compaction boundary", () => {
  const rebuilt = buildCompactionCheckpoint(parse(fixture({ retainNone: true })));
  const compaction = rebuilt.entries.find((entry) => entry.type === "compaction")!;
  expect(compaction.firstKeptEntryId).toBe(compaction.id);
  expect(rebuilt.entries.some((entry) => entry.message?.content === "kept question")).toBe(false);
  expect(replay(rebuilt.entries).active.map((entry) => entry.name)).toEqual(["bash", "read", "write"]);
});

test("manual surgery keeps system deltas when the session has not been compacted", () => {
  const entries = fixture().slice(0, 5);
  const rebuilt = buildSlimSession(parse(entries));
  expect(replay(rebuilt.entries)).toEqual(replay(entries));
});
