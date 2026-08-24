import { expect, test } from "vitest";

import register from "../src/index.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("registers the destructive session command", () => {
  const commands: string[] = [];
  const pi = {
    registerCommand(name: string): void {
      commands.push(name);
    },
  } as unknown as ExtensionAPI;

  register(pi);

  expect(commands).toEqual(["session-surgery"]);
});
