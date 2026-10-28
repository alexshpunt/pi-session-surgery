import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";

import register from "../src/index.js";
import { parseSession, type SlimSession } from "../src/session.js";

const hooks = vi.hoisted(() => ({
  prepared: undefined as ((path: string) => Promise<void>) | undefined,
  cleaned: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    unlink: async (path: string) => {
      try { return await original.unlink(path); }
      finally { hooks.cleaned?.(); }
    },
  };
});
vi.mock("../src/session.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/session.js")>();
  return {
    ...original,
    writeReplacementSession: async (path: string, session: SlimSession) => {
      const raw = await original.writeReplacementSession(path, session);
      await hooks.prepared?.(path);
      return raw;
    },
  };
});

const directories: string[] = [];
afterEach(async () => {
  hooks.prepared = undefined;
  hooks.cleaned = undefined;
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(options: { orphan?: boolean; visibleEdit?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-surgery-stability-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl");
  const entries = [
    { type: "session", version: 3, id: "stability", cwd: directory, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "custom_message", id: "old", parentId: options.orphan ? "missing" : null, customType: "old", content: "Discarded history. ".repeat(1000), display: true, timestamp: "2026-01-01T00:00:01.000Z" },
    { type: "message", id: "kept", parentId: "old", message: { role: "user", content: "Keep this question", timestamp: 2 }, timestamp: "2026-01-01T00:00:02.000Z" },
    { type: "compaction", id: "checkpoint", parentId: "kept", summary: "Preserved summary", firstKeptEntryId: "kept", tokensBefore: 10000, timestamp: "2026-01-01T00:00:03.000Z", systemMessage: { role: "system", content: "Preserved prompt", toolsAdded: [], timestamp: 3 } },
    ...(options.visibleEdit ? [{ type: "context_edit", id: "edit", parentId: "checkpoint", targetId: "kept", replacement: "Edited question", timestamp: "2026-01-01T00:00:04.000Z" }] : []),
  ];
  const original = Buffer.from(entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await writeFile(path, original);
  const manager = SessionManager.open(path);
  const notifications: Array<{ message: string; level: string }> = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  register({ on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), registerCommand: () => {} } as unknown as ExtensionAPI);
  const ctx = {
    cwd: directory, isProjectTrusted: () => false, sessionManager: manager,
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
  };
  handlers.get("session_start")!({ reason: "startup" }, ctx);
  const compact = () => handlers.get("session_compact")!({ compactionEntry: { id: "checkpoint" } }, ctx);
  // Let an old fire-and-forget implementation finish too, so failures do not race cleanup.
  const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 100)); };
  const leftovers = async () => (await readdir(directory)).filter((name) => name !== "session.jsonl");
  return { path, manager, ctx, original, handlers, compact, settle, leftovers, notifications };
}

test("recovers an orphan hidden by the latest checkpoint without changing Pi context or IDs", async () => {
  const live = await setup({ orphan: true });
  const before = live.manager.buildSessionContext();
  await live.compact();
  await live.settle();
  expect(live.notifications.map((notice) => notice.level)).toEqual(["info"]);
  const recovered = parseSession(await readFile(live.path), live.path);
  expect(recovered.entries.some((entry) => entry.id === "old")).toBe(false);
  expect(recovered.entries.filter((entry) => ["kept", "checkpoint"].includes(entry.id!)).map((entry) => entry.id)).toEqual(["kept", "checkpoint"]);
  expect(live.manager.buildSessionContext()).toEqual(before);
  const appended = live.manager.appendMessage({ role: "user", content: "Continue", timestamp: 5 });
  expect(live.manager.getEntry(appended)?.parentId).toBe("checkpoint");
  parseSession(await readFile(live.path), live.path);
  expect(await live.leftovers()).toEqual([]);
});

test("Pi awaits the completed trim before continuing after compaction", async () => {
  const live = await setup();
  const completion = live.compact();
  const wasAwaitable = completion instanceof Promise;
  await completion;
  const reloadedBeforeReturn = !live.manager.getEntries().some((entry) => entry.id === "old");
  await live.settle();
  expect(wasAwaitable).toBe(true);
  expect(reloadedBeforeReturn).toBe(true);
});

test.each(["kept", null] as const)("does not overwrite navigation to %s while preparing a trim", async (target) => {
  const live = await setup();
  hooks.prepared = async () => { target === null ? live.manager.resetLeaf() : live.manager.branch(target); };
  await live.compact();
  await live.settle();
  expect((await readFile(live.path)).equals(live.original)).toBe(true);
  expect(live.manager.getLeafId()).toBe(target);
  expect(await live.leftovers()).toEqual([]);
});

test.each(["same-size", "larger"])("does not overwrite a %s non-append rewrite", async (kind) => {
  const live = await setup();
  let changed: Buffer;
  hooks.prepared = async () => {
    changed = Buffer.from(live.original.toString().replace("Keep this question", kind === "same-size" ? "Keep that question" : "Keep this externally revised question"));
    await writeFile(live.path, changed);
  };
  await live.compact();
  await live.settle();
  expect((await readFile(live.path)).equals(changed!)).toBe(true);
  expect(await live.leftovers()).toEqual([]);
});

test("keeps visible context edits when recovering hidden broken history", async () => {
  const live = await setup({ orphan: true, visibleEdit: true });
  const before = live.manager.buildSessionContext();
  await live.compact();
  await live.settle();
  expect(live.notifications.map((notice) => notice.level)).toEqual(["info"]);
  expect(live.manager.buildSessionContext()).toEqual(before);
  expect(live.manager.getEntry("edit")?.type).toBe("context_edit");
});

test("refuses a valid replacement whose visible context differs from Pi's", async () => {
  const live = await setup();
  hooks.prepared = async (path) => {
    await writeFile(path, (await readFile(path, "utf8")).replace("Keep this question", "Different question"));
  };
  const before = live.manager.buildSessionContext();
  await live.compact();
  expect(live.notifications.map((notice) => notice.level)).toEqual(["error"]);
  expect((await readFile(live.path)).equals(live.original)).toBe(true);
  expect(live.manager.buildSessionContext()).toEqual(before);
  expect(await live.leftovers()).toEqual([]);
});

test.each([0, 1, 2, 3, 4, 5, 6])("drains a request arriving %s microtasks after cleanup", async (delay) => {
  const first = await setup();
  const next = await setup();
  let completion: Promise<void> | undefined;
  hooks.cleaned = () => {
    hooks.cleaned = undefined;
    const enqueue = (remaining: number) => queueMicrotask(() => {
      if (remaining) enqueue(remaining - 1);
      else completion = first.handlers.get("session_compact")!({ compactionEntry: { id: "checkpoint" } }, next.ctx);
    });
    enqueue(delay);
  };
  await first.compact();
  // Flush the scheduled arrival without depending on the worker's internal promise shape.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  expect(completion).toBeInstanceOf(Promise);
  await completion;
  expect(next.notifications.map((notice) => notice.level)).toEqual(["info"]);
  expect(next.manager.getEntry("old")).toBeUndefined();
  expect(await next.leftovers()).toEqual([]);
});

test("cancels prepared work when its session shuts down", async () => {
  const live = await setup();
  hooks.prepared = async () => { live.handlers.get("session_shutdown")!({}, live.ctx); };
  await live.compact();
  expect((await readFile(live.path)).equals(live.original)).toBe(true);
  expect(live.notifications).toEqual([]);
  expect(await live.leftovers()).toEqual([]);
});

test("an obsolete request cannot rewrite or disable the next session", async () => {
  const old = await setup();
  const next = await setup();
  hooks.prepared = async () => {
    hooks.prepared = undefined;
    old.handlers.get("session_shutdown")!({}, old.ctx);
    old.handlers.get("session_start")!({ reason: "resume" }, next.ctx);
    // The next request must retain its own context, not reuse the old request's manager.
    void old.handlers.get("session_compact")!({ compactionEntry: { id: "checkpoint" } }, next.ctx);
  };
  await old.compact();
  expect((await readFile(old.path)).equals(old.original)).toBe(true);
  expect(next.notifications.map((notice) => notice.level)).toEqual(["info"]);
  expect(next.manager.getEntries().some((entry) => entry.id === "old")).toBe(false);
  expect(old.notifications).toEqual([]);
  expect(await old.leftovers()).toEqual([]);
  expect(await next.leftovers()).toEqual([]);
});

test("disables trimming when visible broken history cannot reach its checkpoint", async () => {
  const live = await setup();
  const broken = Buffer.from(live.original.toString() + JSON.stringify({
    type: "custom_message", id: "visible-orphan", parentId: "missing",
    customType: "visible", content: "Must not disappear", display: true,
    timestamp: "2026-01-01T00:00:05.000Z",
  }) + "\n");
  await writeFile(live.path, broken);
  live.manager.setSessionFile(live.path);
  const before = live.manager.buildSessionContext();
  await live.compact();
  expect(live.notifications.map((notice) => notice.level)).toEqual(["error"]);
  await live.compact();
  expect(live.notifications).toHaveLength(1);
  expect((await readFile(live.path)).equals(broken)).toBe(true);
  expect(live.manager.buildSessionContext()).toEqual(before);
  expect(await live.leftovers()).toEqual([]);
});

test("stops retrying an unrecoverable checkpoint and leaves its file unchanged", async () => {
  const live = await setup();
  const broken = Buffer.from(live.original.toString().replace('"firstKeptEntryId":"kept"', '"firstKeptEntryId":"missing"'));
  await writeFile(live.path, broken);
  live.manager.setSessionFile(live.path);
  await live.compact();
  await live.settle();
  expect(live.notifications.map((notice) => notice.level)).toEqual(["error"]);
  await live.compact();
  await live.settle();
  expect(live.notifications).toHaveLength(1);
  expect(readFileSync(live.path).equals(broken)).toBe(true);
  expect(await live.leftovers()).toEqual([]);
});
