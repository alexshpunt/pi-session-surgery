import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import register from "../src/index.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SlimSession } from "../src/session.js";

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

test("registers manual and automatic session commands", () => {
  const { commandsInOrder } = createPi();

  expect(commandsInOrder).toEqual(["session-surgery", "session-surgery-auto"]);
});

test("queues automatic surgery after a successful compaction", async () => {
  vi.useFakeTimers();
  const { handlers, sent } = createPi();

  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, startContext());
  handlers.get("session_compact")?.(
    { compactionEntry: { id: "compact-1" } },
    { isIdle: () => true, hasPendingMessages: () => false },
  );
  await vi.runAllTimersAsync();

  expect(sent).toEqual([
    {
      content: "/session-surgery-auto compact-1",
      options: { deliverAs: "followUp", expandPromptTemplates: true },
    },
  ]);
  vi.useRealTimers();
});

test("waits for queued work and keeps the trim request across a session switch", async () => {
  vi.useFakeTimers();
  const { handlers, sent } = createPi();

  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, startContext());
  handlers.get("session_compact")?.(
    { compactionEntry: { id: "compact-1" } },
    { isIdle: () => true, hasPendingMessages: () => true },
  );
  await vi.runAllTimersAsync();
  expect(sent).toEqual([]);

  handlers.get("session_shutdown")?.({}, {});
  handlers.get("session_start")?.({ type: "session_start", reason: "switch" }, startContext());
  handlers.get("agent_settled")?.({}, { isIdle: () => true, hasPendingMessages: () => false });
  await vi.runAllTimersAsync();

  expect(sent).toEqual([
    {
      content: "/session-surgery-auto compact-1",
      options: { deliverAs: "followUp", expandPromptTemplates: true },
    },
  ]);
  vi.useRealTimers();
});

test("keeps the trim request when the session context goes stale before dispatch", async () => {
  vi.useFakeTimers();
  const { handlers, sent } = createPi();
  const staleError = new Error("This extension ctx is stale after session replacement or reload.");

  let replaced = false;
  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, startContext());
  handlers.get("session_compact")?.(
    { compactionEntry: { id: "compact-1" } },
    { isIdle: () => false, hasPendingMessages: () => false },
  );
  // This context schedules the dispatch, then dies before the timer runs.
  handlers.get("agent_settled")?.(
    {},
    {
      isIdle: () => true,
      hasPendingMessages: () => {
        if (replaced) throw staleError;
        return false;
      },
    },
  );
  replaced = true;
  await vi.runAllTimersAsync();
  expect(sent).toEqual([]);

  handlers.get("session_start")?.({ type: "session_start", reason: "switch" }, startContext());
  handlers.get("agent_settled")?.({}, { isIdle: () => true, hasPendingMessages: () => false });
  await vi.runAllTimersAsync();

  expect(sent.map((message) => message.content)).toEqual(["/session-surgery-auto compact-1"]);
  vi.useRealTimers();
});

test("defers the switch while entries arrived after the snapshot and retries on the next settle", async () => {
  vi.useFakeTimers();
  const { handlers, commands, sent } = createPi();
  const sourcePath = await sessionFile();
  let appended = false;
  sessionHooks.afterReplacementWritten = async () => {
    if (appended) return;
    appended = true;
    await appendFile(sourcePath, appendedEntry("u3"));
  };

  const first = createCommandContext({ sessionFile: sourcePath });
  await commands.get("session-surgery-auto")?.("c1", first.ctx);

  // The session moved on while the replacement was written: no switch, no leftover file.
  expect(first.switched).toEqual([]);
  expect(first.notified).toEqual([]);
  expect(await leftoverReplacements(sourcePath)).toEqual([]);

  // The request stays pending, so the next settle dispatches it again.
  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, startContext());
  handlers.get("agent_settled")?.({}, { isIdle: () => true, hasPendingMessages: () => false });
  await vi.runAllTimersAsync();

  expect(sent.map((message) => message.content)).toEqual(["/session-surgery-auto c1"]);
  vi.useRealTimers();
});

test("defers the switch while queued work is waiting", async () => {
  const { commands } = createPi();
  const sourcePath = await sessionFile();

  const deferred = createCommandContext({ sessionFile: sourcePath, pendingMessages: true });
  await commands.get("session-surgery-auto")?.("c1", deferred.ctx);

  expect(deferred.switched).toEqual([]);
  expect(await leftoverReplacements(sourcePath)).toEqual([]);
});

test("dispatches after manual compaction becomes idle without another agent run", async () => {
  vi.useFakeTimers();
  const { handlers, sent } = createPi();
  let idle = false;
  handlers.get("session_compact")?.(
    { compactionEntry: { id: "c1" } },
    { isIdle: () => idle, hasPendingMessages: () => false },
  );
  idle = true;
  await vi.runAllTimersAsync();
  expect(sent.map((message) => message.content)).toEqual(["/session-surgery-auto c1"]);
});

test("lets an immediate continuation finish before dispatching surgery", async () => {
  vi.useFakeTimers();
  const { handlers, sent } = createPi();
  let idle = true;
  const ctx = { isIdle: () => idle, hasPendingMessages: () => false };
  handlers.get("session_compact")?.({ compactionEntry: { id: "c1" } }, ctx);
  idle = false;
  await vi.runAllTimersAsync();
  expect(sent).toEqual([]);

  idle = true;
  handlers.get("agent_settled")?.({}, ctx);
  await vi.runAllTimersAsync();
  expect(sent.map((message) => message.content)).toEqual(["/session-surgery-auto c1"]);
});

test("retries a changing snapshot while idle and preserves the appended entry", async () => {
  vi.useFakeTimers();
  const { commands, sent } = createPi();
  const sourcePath = await sessionFile();
  sessionHooks.afterSourceRead = async () => {
    sessionHooks.afterSourceRead = undefined;
    await appendFile(sourcePath, appendedEntry("u3"));
  };
  const first = createCommandContext({ sessionFile: sourcePath });
  await commands.get("session-surgery-auto")?.("c1", first.ctx);
  expect(first.switched).toEqual([]);
  expect(first.notified).toEqual([]);
  expect(await leftoverReplacements(sourcePath)).toEqual([]);

  // No agent_settled event: an idle session still gets a bounded retry.
  await vi.runAllTimersAsync();
  expect(sent.map((message) => message.content)).toEqual(["/session-surgery-auto c1"]);
  const retry = createCommandContext({ sessionFile: sourcePath });
  await commands.get("session-surgery-auto")?.("c1", retry.ctx);
  expect(retry.switched).toHaveLength(1);
  const entries = (await readFile(retry.switched[0], "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(entries.map((entry) => entry.message)).toContainEqual(JSON.parse(appendedEntry("u3")).message);
});

test("reports the trim after the switch so Pi's own resume status is replaced", async () => {
  const { commands } = createPi();
  const sourcePath = await sessionFile();
  const context = createCommandContext({ sessionFile: sourcePath });

  await commands.get("session-surgery-auto")?.("c1", context.ctx);

  expect(context.switched).toHaveLength(1);
  // Pi prints "Resumed session" once switchSession resolves, so the report has to come last.
  expect(context.events).toEqual(["switch", "switched", "notify"]);
  expect(context.notified.map((notice) => notice.level)).toEqual(["info"]);
  expect(context.notified[0]?.message).toMatch(
    /^Compacted session trimmed: [\d.]+ (?:B|KB|MB) → [\d.]+ (?:B|KB|MB); the session file was replaced$/,
  );
});

test("bounds idle retries and retains the request for the next settle", async () => {
  vi.useFakeTimers();
  const { handlers, commands, sent } = createPi();
  const sourcePath = await sessionFile();
  let appended = 0;
  sessionHooks.afterSourceRead = async () => {
    await appendFile(sourcePath, appendedEntry("race-" + ++appended));
  };
  const attempt = createCommandContext({ sessionFile: sourcePath });
  for (let i = 0; i < 4; i++) {
    await commands.get("session-surgery-auto")?.("c1", attempt.ctx);
    await vi.runAllTimersAsync();
  }
  expect(attempt.notified).toEqual([]);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.length).toBeLessThan(4);

  const dispatched = sent.length;
  handlers.get("agent_settled")?.({}, attempt.ctx);
  await vi.runAllTimersAsync();
  expect(sent).toHaveLength(dispatched + 1);
});

test("rechecks idle after the final asynchronous source validation", async () => {
  const { commands } = createPi();
  const sourcePath = await sessionFile();
  let idle = true;
  const attempt = createCommandContext({ sessionFile: sourcePath });
  attempt.ctx.isIdle = () => idle;
  sessionHooks.afterReplacementWritten = async () => {
    sessionHooks.afterSourceStat = () => { idle = false; };
  };
  await commands.get("session-surgery-auto")?.("c1", attempt.ctx);
  expect(attempt.switched).toEqual([]);
  expect(attempt.notified).toEqual([]);
  expect(await leftoverReplacements(sourcePath)).toEqual([]);
});

test("reports filesystem failures rather than treating them as a changing snapshot", async () => {
  vi.useFakeTimers();
  const { commands, sent } = createPi();
  const sourcePath = await sessionFile();
  await rm(sourcePath);
  const attempt = createCommandContext({ sessionFile: sourcePath });
  await commands.get("session-surgery-auto")?.("c1", attempt.ctx);
  await vi.runAllTimersAsync();
  expect(attempt.notified.map((notice) => notice.level)).toEqual(["error"]);
  expect(sent).toEqual([]);
});

test("keeps the newest compaction pending until an in-flight trim finishes", async () => {
  vi.useFakeTimers();
  const { handlers, commands, sent } = createPi();
  const sourcePath = await sessionFile();
  let release!: () => void;
  let writing!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { writing = resolve; });
  sessionHooks.afterReplacementWritten = async () => {
    sessionHooks.afterReplacementWritten = undefined;
    writing();
    await paused;
  };
  const first = createCommandContext({ sessionFile: sourcePath });
  // Also cover a dispatch timer that was armed just before this command started.
  handlers.get("session_compact")?.({ compactionEntry: { id: "c1" } }, first.ctx);
  const running = commands.get("session-surgery-auto")!("c1", first.ctx);
  await reached;
  try {
    await appendFile(sourcePath, JSON.stringify({
      type: "compaction", id: "c2", parentId: "u2", summary: "newer summary",
      firstKeptEntryId: "u2", tokensBefore: 20,
    }) + "\n");
    handlers.get("session_compact")?.({ compactionEntry: { id: "c2" } }, first.ctx);
    handlers.get("agent_settled")?.({}, first.ctx);
    await vi.runAllTimersAsync();
    expect(sent).toEqual([]);
  } finally {
    release();
    await running;
  }
  expect(first.switched).toEqual([]);
  expect(first.notified).toEqual([]);
  await vi.runAllTimersAsync();
  expect(sent.map((message) => message.content)).toEqual(["/session-surgery-auto c2"]);
  const next = createCommandContext({ sessionFile: sourcePath });
  await commands.get("session-surgery-auto")!("c2", next.ctx);
  expect(next.switched).toHaveLength(1);
});

test("does not run a second automatic command concurrently", async () => {
  const { commands } = createPi();
  const sourcePath = await sessionFile();
  let release!: () => void;
  let writing!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { writing = resolve; });
  sessionHooks.afterReplacementWritten = async () => {
    sessionHooks.afterReplacementWritten = undefined;
    writing();
    await paused;
  };
  const first = createCommandContext({ sessionFile: sourcePath });
  const second = createCommandContext({ sessionFile: sourcePath });
  const running = commands.get("session-surgery-auto")!("c1", first.ctx);
  await reached;
  try {
    await commands.get("session-surgery-auto")!("c1", second.ctx);
    expect(second.switched).toEqual([]);
    expect(second.notified).toEqual([]);
  } finally {
    release();
    await running;
  }
  expect(first.switched).toHaveLength(1);
});

test("removes the prepared file when the switch is cancelled", async () => {
  const { commands } = createPi();
  const sourcePath = await sessionFile();

  const cancelled = createCommandContext({ sessionFile: sourcePath, cancelSwitch: true });
  await commands.get("session-surgery-auto")?.("c1", cancelled.ctx);

  expect(cancelled.switched).toHaveLength(1);
  expect(await leftoverReplacements(sourcePath)).toEqual([]);
  await expect(readdir(join(sourcePath, ".."))).resolves.toContain("session.jsonl");
});
