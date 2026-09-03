import { expect, test, vi } from "vitest";

import register from "../src/index.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("registers manual and automatic session commands", () => {
  const commands: string[] = [];
  const pi = {
    on(): void {},
    registerCommand(name: string): void {
      commands.push(name);
    },
  } as unknown as ExtensionAPI;

  register(pi);

  expect(commands).toEqual(["session-surgery", "session-surgery-auto"]);
});

test("queues automatic surgery after a successful compaction", async () => {
  vi.useFakeTimers();
  const handlers = new Map<string, (...args: any[]) => void>();
  const sent: Array<{ content: string; options: unknown }> = [];
  const pi = {
    on(name: string, handler: (...args: any[]) => void): void {
      handlers.set(name, handler);
    },
    registerCommand(): void {},
    sendUserMessage(content: string, options: unknown): void {
      sent.push({ content, options });
    },
  } as unknown as ExtensionAPI;
  register(pi);

  handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    {
      cwd: "/tmp/project",
      isProjectTrusted: () => false,
      ui: { notify: () => undefined },
    },
  );
  handlers.get("session_compact")?.({ compactionEntry: { id: "compact-1" } }, { isIdle: () => true });
  await vi.runAllTimersAsync();

  expect(sent).toEqual([
    {
      content: "/session-surgery-auto compact-1",
      options: { expandPromptTemplates: true },
    },
  ]);
  vi.useRealTimers();
});
