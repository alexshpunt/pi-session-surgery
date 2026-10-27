import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import register from "../src/index.js";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SlimSession } from "../src/session.js";
import { parseSession } from "../src/session.js";

/** Pause real filesystem operations at the race boundaries under test. */
const sessionHooks = vi.hoisted(() => ({
  afterReplacementWritten: undefined as (() => Promise<void>) | undefined,
  afterSourceRead: undefined as (() => Promise<void>) | undefined,
  afterSourceStat: undefined as (() => void) | undefined,
}));

vi.mock("../src/session.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/session.js")>();
  return {
    ...original,
    writeReplacementSession: async (path: string, session: SlimSession) => {
      const raw = await original.writeReplacementSession(path, session);
      await sessionHooks.afterReplacementWritten?.();
      return raw;
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      const raw = await original.readFile(...args);
      await sessionHooks.afterSourceRead?.();
      return raw;
    },
    stat: async (...args: Parameters<typeof original.stat>) => {
      const result = await original.stat(...args);
      sessionHooks.afterSourceStat?.();
      return result;
    },
  };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  sessionHooks.afterReplacementWritten = undefined;
  sessionHooks.afterSourceRead = undefined;
  sessionHooks.afterSourceStat = undefined;
  vi.useRealTimers();
});

type EventHandler = (...args: any[]) => unknown;
type CommandHandler = (args: string, ctx: any) => Promise<void>;

/** Register the extension against a fake Pi and expose everything a test can drive. */
function createPi() {
  const handlers = new Map<string, EventHandler>();
  const commands = new Map<string, CommandHandler>();
  const commandsInOrder: string[] = [];
  const sent: Array<{ content: string; options: unknown }> = [];
  const pi = {
    on(name: string, handler: EventHandler): void {
      handlers.set(name, handler);
    },
    registerCommand(name: string, options: { handler: CommandHandler }): void {
      commandsInOrder.push(name);
      commands.set(name, options.handler);
    },
    sendUserMessage(content: string, options: unknown): void {
      sent.push({ content, options });
    },
  } as unknown as ExtensionAPI;
  register(pi);
  return { handlers, commands, commandsInOrder, sent };
}

function startContext() {
  return { cwd: "/tmp/project", isProjectTrusted: () => false, ui: { notify: () => undefined } };
}

/** One session whose newest compaction leaves a visible tail to trim. */
function sessionFixtureText(): string {
  const entries = [
    { type: "session", version: 3, id: "fixture-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "first question", timestamp: 1 },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "first answer" }], stopReason: "stop" },
    },
    {
      type: "compaction",
      id: "c1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "summary",
      firstKeptEntryId: "a1",
      tokensBefore: 10,
    },
    {
      type: "message",
      id: "u2",
      parentId: "c1",
      timestamp: "2026-01-01T00:00:04.000Z",
      message: { role: "user", content: "second question", timestamp: 2 },
    },
  ];
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** The visible tail of the fixture, as it appears in the session file. */
function appendedEntry(id: string): string {
  return `${JSON.stringify({
    type: "message",
    id,
    parentId: "c1",
    timestamp: "2026-01-01T00:00:05.000Z",
    message: { role: "user", content: "arrived during the trim", timestamp: 3 },
  })}\n`;
}

/** A session whose newest compaction kept every entry, so a trim has nothing to drop. */
async function keepingSessionFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-surgery-keeping-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "session.jsonl");
  const entries = [
    { type: "session", version: 3, id: "keeping-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "first question", timestamp: 1 },
    },
    {
      type: "compaction",
      id: "keep-all",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:02.000Z",
      summary: "summary",
      firstKeptEntryId: "u1",
      tokensBefore: 10,
    },
  ];
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return path;
}

async function sessionFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-session-surgery-index-"));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, "session.jsonl");
  await writeFile(sourcePath, sessionFixtureText());
  return sourcePath;
}

async function leftoverReplacements(sourcePath: string): Promise<string[]> {
  const entries = await readdir(join(sourcePath, ".."));
  return entries.filter((name) => name.includes("surgery"));
}

interface FakeCommandContext {
  ctx: any;
  notified: Array<{ message: string; level: string }>;
  switched: string[];
  events: string[];
}

/** A command context that records the switch instead of moving the session. */
function createCommandContext(options: {
  sessionFile: string;
  pendingMessages?: boolean;
  idle?: boolean;
  cancelSwitch?: boolean;
}): FakeCommandContext {
  const notified: Array<{ message: string; level: string }> = [];
  const switched: string[] = [];
  const events: string[] = [];
  const notify = (message: string, level: string): void => {
    events.push("notify");
    notified.push({ message, level });
  };
  const ctx = {
    sessionManager: { getSessionFile: () => options.sessionFile },
    waitForIdle: async () => undefined,
    isIdle: () => options.idle ?? true,
    hasPendingMessages: () => options.pendingMessages ?? false,
    switchSession: async (path: string, switchOptions: { withSession: (nextCtx: any) => Promise<void> }) => {
      events.push("switch");
      switched.push(path);
      if (options.cancelSwitch) return { cancelled: true };
      await switchOptions.withSession({ ui: { notify } });
      events.push("switched");
      return { cancelled: false };
    },
    ui: { notify },
  };
  return { ctx, notified, switched, events };
}


/** A live session context: Pi's manager shows the current file and can re-read it. */
interface FakeLiveContext {
  ctx: any;
  notified: Array<{ message: string; level: string }>;
  switched: string[];
  reopened: string[];
}

function createLiveContext(sessionFile: string, options: { reopenable?: boolean } = {}): FakeLiveContext {
  const notified: Array<{ message: string; level: string }> = [];
  const switched: string[] = [];
  const reopened: string[] = [];
  const sessionManager: Record<string, unknown> = {
    getSessionFile: () => sessionFile,
    getCwd: () => "/tmp/project",
  };
  if (options.reopenable ?? true) {
    sessionManager.setSessionFile = (path: string) => {
      reopened.push(path);
    };
  }
  const ctx = {
    cwd: "/tmp/project",
    isProjectTrusted: () => false,
    sessionManager,
    switchSession: async (path: string) => {
      switched.push(path);
      return { cancelled: false };
    },
    ui: {
      notify: (message: string, level: string) => {
        notified.push({ message, level });
      },
    },
  };
  return { ctx, notified, switched, reopened };
}

/** Wait until the fire-and-forget trim reached the state the test is about to assert. */
async function settle(assertion: () => void | Promise<void>): Promise<void> {
  await vi.waitFor(assertion, { timeout: 3000, interval: 10 });
}

test("registers the manual surgery command", () => {
  expect(createPi().commandsInOrder).toEqual(["session-surgery"]);
});

test("rewrites the session in place right after a compaction", async () => {
  const { handlers } = createPi();
  const sourcePath = await sessionFile();
  const originalPath = join(await mkdtemp(join(tmpdir(), "pi-session-surgery-original-")), "session.jsonl");
  temporaryDirectories.push(join(originalPath, ".."));
  await writeFile(originalPath, sessionFixtureText());
  const before = (await stat(sourcePath)).size;
  const live = createLiveContext(sourcePath);

  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, live.ctx);
  handlers.get("session_compact")?.({ compactionEntry: { id: "c1" } }, live.ctx);
  await settle(() => expect(live.reopened).toEqual([sourcePath]));

  // Same file, same session, no switch, no leftover replacement.
  expect(live.switched).toEqual([]);
  expect(await leftoverReplacements(sourcePath)).toEqual([]);
  expect((await stat(sourcePath)).size).toBeLessThan(before);
  // What the model sees is unchanged.
  expect(SessionManager.open(sourcePath).buildSessionContext()).toEqual(
    SessionManager.open(originalPath).buildSessionContext(),
  );
  expect(live.notified.map((notice) => notice.level)).toEqual(["info"]);
  expect(live.notified[0]?.message).toMatch(
    /^Compacted session trimmed: [\d.]+ (?:B|KB|MB) → [\d.]+ (?:B|KB|MB)$/,
  );
});

test("carries over entries appended while the trim was prepared", async () => {
  const { handlers } = createPi();
  const sourcePath = await sessionFile();
  sessionHooks.afterReplacementWritten = async () => {
    sessionHooks.afterReplacementWritten = undefined;
    await appendFile(sourcePath, appendedEntry("u3"));
  };
  const live = createLiveContext(sourcePath);

  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, live.ctx);
  handlers.get("session_compact")?.({ compactionEntry: { id: "c1" } }, live.ctx);
  await settle(() => expect(live.reopened).toEqual([sourcePath]));

  const entries = (await readFile(sourcePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(entries.map((entry) => entry.id)).toContain("u3");
  const ids = new Set(entries.slice(1).map((entry) => entry.id));
  expect(entries.slice(1).every((entry) => entry.parentId === null || ids.has(entry.parentId))).toBe(true);
  const context = SessionManager.open(sourcePath).buildSessionContext();
  expect(context.messages.some((message) => message.role === "user" && message.content === "arrived during the trim")).toBe(true);
});

test("keeps the real live manager and appended parents valid across repeated compactions", async () => {
  const { handlers } = createPi();
  const sourcePath = await sessionFile();
  const manager = SessionManager.open(sourcePath);
  manager.appendModelChange("fixture", "fixture-model");
  const live = createLiveContext(sourcePath);
  live.ctx.sessionManager = manager;
  const sessionId = manager.getSessionId();
  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, live.ctx);

  for (let round = 1; round <= 5; round += 1) {
    manager.appendMessage({ role: "user", content: "Discarded history. ".repeat(500), timestamp: round });
    const boundary = manager.appendMessage({ role: "user", content: `Keep round ${round}`, timestamp: round });
    const compactionId = manager.appendCompaction(`Summary ${round}`, boundary, 10000);
    const before = (await stat(sourcePath)).size;
    let appendedId: string | undefined;
    let expectedContext: ReturnType<typeof manager.buildSessionContext> | undefined;
    sessionHooks.afterReplacementWritten = async () => {
      sessionHooks.afterReplacementWritten = undefined;
      // Pi continues before the asynchronous rewrite commits, using the original leaf ID.
      appendedId = manager.appendMessage({ role: "user", content: `During trim ${round}`, timestamp: round });
      expectedContext = manager.buildSessionContext();
    };

    handlers.get("session_compact")?.({ compactionEntry: { id: compactionId } }, live.ctx);
    await settle(() => expect(live.notified).toHaveLength(round));
    expect(live.notified.at(-1)?.level, live.notified.at(-1)?.message).toBe("info");
    const parsed = parseSession(await readFile(sourcePath), sourcePath);
    expect(parsed.entries.filter((entry) => entry.type === "compaction").map((entry) => entry.id)).toEqual([compactionId]);
    expect(parsed.entries.find((entry) => entry.id === appendedId)?.parentId).toBe(compactionId);
    expect(manager.getLeafId()).toBe(appendedId);
    expect(manager.getEntries()).toEqual(parsed.entries);
    expect(manager.buildSessionContext()).toEqual(expectedContext);
    expect(manager.getSessionFile()).toBe(sourcePath);
    expect(manager.getSessionId()).toBe(sessionId);
    expect((await stat(sourcePath)).size).toBeLessThan(before);

    // A new append must use the reloaded leaf, not a stale or regenerated ID.
    const afterId = manager.appendMessage({ role: "user", content: `After trim ${round}`, timestamp: round });
    expect(manager.getEntry(afterId)?.parentId).toBe(appendedId);
    parseSession(await readFile(sourcePath), sourcePath);
  }
  expect(await leftoverReplacements(sourcePath)).toEqual([]);
});

test("does not replace the file if an appended entry references discarded history", async () => {
  const { handlers } = createPi();
  const sourcePath = await sessionFile();
  const appended = appendedEntry("u3").replace('"parentId":"c1"', '"parentId":"u1"');
  sessionHooks.afterReplacementWritten = async () => {
    sessionHooks.afterReplacementWritten = undefined;
    await appendFile(sourcePath, appended);
  };
  const live = createLiveContext(sourcePath);
  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, live.ctx);
  handlers.get("session_compact")?.({ compactionEntry: { id: "c1" } }, live.ctx);
  await settle(() => expect(live.notified.some((notice) => notice.level === "error")).toBe(true));
  expect(live.reopened).toEqual([]);
  expect(await readFile(sourcePath, "utf8")).toBe(sessionFixtureText() + appended);
  expect(await leftoverReplacements(sourcePath)).toEqual([]);
});
test("ignores a compaction that is no longer in the active branch", async () => {
  const { handlers } = createPi();
  const sourcePath = await sessionFile();
  const before = await readFile(sourcePath, "utf8");
  const live = createLiveContext(sourcePath);

  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, live.ctx);
  handlers.get("session_compact")?.({ compactionEntry: { id: "not-in-this-session" } }, live.ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(live.reopened).toEqual([]);
  expect(live.notified).toEqual([]);
  expect(await readFile(sourcePath, "utf8")).toBe(before);
});

test("leaves a session that kept all its history alone", async () => {
  const { handlers } = createPi();
  const keepingPath = await keepingSessionFile();
  const before = await readFile(keepingPath, "utf8");
  const live = createLiveContext(keepingPath);

  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, live.ctx);
  handlers.get("session_compact")?.({ compactionEntry: { id: "keep-all" } }, live.ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(live.reopened).toEqual([]);
  expect(live.notified).toEqual([]);
  expect(await readFile(keepingPath, "utf8")).toBe(before);
  expect(await leftoverReplacements(keepingPath)).toEqual([]);
});

test("reports a session file it cannot read instead of rewriting it", async () => {
  const { handlers } = createPi();
  const sourcePath = await sessionFile();
  await rm(sourcePath);
  const live = createLiveContext(sourcePath);

  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, live.ctx);
  handlers.get("session_compact")?.({ compactionEntry: { id: "c1" } }, live.ctx);
  await settle(() => expect(live.notified.map((notice) => notice.level)).toEqual(["error"]));

  expect(live.reopened).toEqual([]);
  expect(live.notified[0]?.message).toContain("Automatic session surgery failed");
});

test("keeps automatic surgery off when Pi cannot reopen the live file", async () => {
  const { handlers } = createPi();
  const sourcePath = await sessionFile();
  const before = await readFile(sourcePath, "utf8");
  const live = createLiveContext(sourcePath, { reopenable: false });

  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, live.ctx);
  expect(live.notified.map((notice) => notice.level)).toEqual(["warning"]);

  handlers.get("session_compact")?.({ compactionEntry: { id: "c1" } }, live.ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(live.notified).toHaveLength(1);
  expect(live.reopened).toEqual([]);
  expect(await readFile(sourcePath, "utf8")).toBe(before);
});

test("runs one trim at a time and serves the newest request", async () => {
  const { handlers } = createPi();
  const sourcePath = await sessionFile();
  let release!: () => void;
  let writing!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    writing = resolve;
  });
  sessionHooks.afterReplacementWritten = async () => {
    sessionHooks.afterReplacementWritten = undefined;
    writing();
    await paused;
  };
  const live = createLiveContext(sourcePath);

  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, live.ctx);
  handlers.get("session_compact")?.({ compactionEntry: { id: "c1" } }, live.ctx);
  await reached;
  // A second compaction lands while the first trim is still preparing its replacement.
  handlers.get("session_compact")?.({ compactionEntry: { id: "c2" } }, live.ctx);
  release();
  await settle(() => expect(live.notified.length).toBeGreaterThanOrEqual(1));

  // The stale request was dropped: c2 is not in the session, so no second rewrite was attempted.
  expect(live.reopened).toEqual([sourcePath]);
  expect(await leftoverReplacements(sourcePath)).toEqual([]);
});

test("removes the prepared file when the manual switch is cancelled", async () => {
  const { commands } = createPi();
  const sourcePath = await sessionFile();

  const cancelled = createCommandContext({ sessionFile: sourcePath, cancelSwitch: true });
  cancelled.ctx.hasUI = true;
  cancelled.ctx.ui.confirm = async () => true;
  await commands.get("session-surgery")?.("", cancelled.ctx);

  expect(cancelled.switched).toHaveLength(1);
  expect(await leftoverReplacements(sourcePath)).toEqual([]);
  await expect(readdir(join(sourcePath, ".."))).resolves.toContain("session.jsonl");
});
