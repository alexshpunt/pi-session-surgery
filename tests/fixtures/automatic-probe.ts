import { appendFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import register from "../../src/index.js";

/**
 * Drive a real Pi through a compaction and record what the extension did to the live session.
 *
 * The session sizes are taken while Pi still owns the file: before the trim in `session_compact`
 * and after it in `session_shutdown`.
 */
export default function probe(pi: ExtensionAPI): void {
  let compactOnSettle = false;

  const record = (ctx: any, event: string, data: object = {}): void => {
    appendFileSync(join(ctx.cwd, "surgery-probe.jsonl"), JSON.stringify({ event, ...data }) + "\n");
  };
  const sizeOf = (file: string | undefined): number => (file && existsSync(file) ? statSync(file).size : 0);

  register(pi);

  pi.on("session_start", (event, ctx) => {
    // A session replacement arrives here as "resume"; the in-place trim must never produce one.
    if (event.reason === "resume") record(ctx, "resumed");
    if (event.reason !== "startup") return;
    compactOnSettle = true;
    record(ctx, "startup", { file: ctx.sessionManager.getSessionFile() });
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!compactOnSettle) return;
    compactOnSettle = false;
    record(ctx, "compact-request");
    ctx.compact({
      onComplete: () => {
        pi.sendMessage({
          customType: "probe-continuation",
          content: "Write result.txt containing done.",
          display: true,
        }, { triggerTurn: true });
      },
    });
  });

  pi.on("session_compact", (_event, ctx) => {
    record(ctx, "compacted", { file: ctx.sessionManager.getSessionFile(), size: sizeOf(ctx.sessionManager.getSessionFile()) });
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (existsSync(join(ctx.cwd, "result.txt"))) record(ctx, "result-written");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    record(ctx, "shutdown", { file: ctx.sessionManager.getSessionFile(), size: sizeOf(ctx.sessionManager.getSessionFile()) });
  });
}
