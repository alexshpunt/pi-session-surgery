import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../../src/index.js";

/** Observe real Pi and append real extension state during the first snapshot read. */
export default function probe(pi: ExtensionAPI): void {
  const mode = process.env.SURGERY_PROBE_MODE;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let injected = false;
  let compactOnSettle = false;
  const record = (ctx: any, event: string, data: object = {}): void => {
    appendFileSync(join(ctx.cwd, "surgery-probe.jsonl"), JSON.stringify({ event, ...data }) + "\n");
  };

  const observeContext = (ctx: any): any => new Proxy(ctx, {
    get(target, key) {
      if (key === "ui") return new Proxy(target.ui, {
        get(ui, name) {
          if (name === "notify") return (message: string, level: string) => {
            record(ctx, "notify", { level });
            return ui.notify(message, level);
          };
          const value = ui[name];
          return typeof value === "function" ? value.bind(ui) : value;
        },
      });
      if (key === "waitForIdle") return async () => {
        await target.waitForIdle();
        if (mode === "race" && !injected) {
          injected = true;
          heartbeat = setInterval(() => pi.appendEntry("probe-heartbeat", { value: 42 }), 1);
        }
      };
      if (key === "switchSession") return (...args: any[]) => {
        record(ctx, "switch", { idle: target.isIdle(), pending: target.hasPendingMessages() });
        return target.switchSession(...args);
      };
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  register(new Proxy(pi, {
    get(target, key) {
      if (key === "on") return (event: string, handler: any) =>
        (target.on as any)(event, (data: any, ctx: any) => handler(data, observeContext(ctx)));
      if (key === "registerCommand") return (name: string, options: any) =>
        target.registerCommand(name, {
          ...options,
          handler: async (args: string, ctx: any) => {
            const source = ctx.sessionManager.getSessionFile();
            const cwd = ctx.cwd;
            record(ctx, "command", { name });
            try {
              await options.handler(args, observeContext(ctx));
            } finally {
              clearInterval(heartbeat);
            }
            record({ cwd }, "command-end", { sourceRemoved: !existsSync(source) });
          },
        });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }));

  pi.on("session_start", (event, ctx) => {
    compactOnSettle = event.reason === "startup";
    if (event.reason === "resume") {
      record(ctx, "resumed", {
        types: ctx.sessionManager.getBranch().map((entry: any) => entry.customType ?? entry.type),
        heartbeats: ctx.sessionManager.getBranch()
          .filter((entry: any) => entry.customType === "probe-heartbeat")
          .map((entry: any) => entry.data),
      });
      // The final scripted response keeps the harness alive until surgery has really switched.
      setTimeout(() => pi.sendMessage({
        customType: "probe-verified",
        content: "The checkpoint was replaced. Finish verification.",
        display: true,
      }, { triggerTurn: true }), 0);
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!compactOnSettle) return;
    compactOnSettle = false;
    ctx.compact({
      onComplete: () => {
        if (mode === "manual") return;
        pi.sendMessage({
          customType: "probe-continuation",
          content: "Write result.txt containing done.",
          display: true,
        }, { triggerTurn: true });
      },
    });
  });

  pi.on("session_compact", (_event, ctx) => {
    record(ctx, "compacted", { idle: ctx.isIdle() });
    if (mode === "race") pi.appendEntry("probe-state", { payload: "x".repeat(5_000_000) });
  });

  pi.on("session_shutdown", () => clearInterval(heartbeat));
}
