import { appendFileSync, copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { buildSessionContext, type BoundaryResult, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";

import register from "../../src/index.ts";

/** Create public boundary drafts; do not imitate session_compact or call surgery directly. */
export default function probe(pi: ExtensionAPI): void {
  const boundary = process.env.PI_SURGERY_TEST_BOUNDARY ?? "agent_before_settle";
  const retainNone = process.env.PI_SURGERY_TEST_RETAIN_NONE === "1";
  const continueRun = process.env.PI_SURGERY_TEST_CONTINUE !== "0";
  const rounds = Number(process.env.PI_SURGERY_TEST_COMPACTIONS ?? 3);
  let round = 0;
  let ready = false;
  let seen: string | undefined;
  let before: { checkpoint: string; context: ReturnType<typeof buildSessionContext> } | undefined;

  const record = (ctx: ExtensionContext, event: string, data: object = {}): void => {
    appendFileSync(join(ctx.cwd, "boundary-probe.jsonl"), JSON.stringify({ event, ...data }) + "\n");
  };
  const contextOf = (ctx: ExtensionContext) =>
    buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
  const snapshot = (ctx: ExtensionContext) => {
    const file = ctx.sessionManager.getSessionFile();
    const entries = file && existsSync(file)
      ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)).slice(1)
      : [];
    return {
      file, sessionId: ctx.sessionManager.getSessionId(), leaf: ctx.sessionManager.getLeafId(),
      size: file && existsSync(file) ? statSync(file).size : 0,
      compactions: entries.filter((entry) => entry.type === "compaction").length,
      states: entries.filter((entry) => entry.type === "custom" && entry.customType === "boundary-state").length,
    };
  };
  const observeBefore = (_event: unknown, ctx: ExtensionContext): void => {
    const checkpoint = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "compaction");
    if (!checkpoint || checkpoint.id === seen) return;
    seen = checkpoint.id;
    before = { checkpoint: checkpoint.id, context: structuredClone(contextOf(ctx)) };
    record(ctx, "before-trim", { checkpoint: checkpoint.id, ...snapshot(ctx) });
  };
  const observeAfter = (_event: unknown, ctx: ExtensionContext): void => {
    if (!before) return;
    record(ctx, "after-trim", {
      checkpoint: before.checkpoint, ...snapshot(ctx),
      contextUnchanged: isDeepStrictEqual(before.context, contextOf(ctx)),
    });
    before = undefined;
  };
  pi.on("turn_start", observeBefore);
  pi.on("agent_settled", observeBefore);
  register(pi);
  pi.on("turn_start", observeAfter);
  pi.on("agent_settled", observeAfter);
  pi.on("session_compact", (_event, ctx) => record(ctx, "session-compact"));

  const draft = (event: { entries: SessionBoundaryDraft[] }, ctx: ExtensionContext): BoundaryResult => {
    ready = false;
    round += 1;
    const lastMessage = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message");
    if (!lastMessage) throw new Error("No persisted boundary for the test checkpoint");
    record(ctx, "drafted", { round });
    return {
      entries: [
        ...event.entries,
        { type: "custom", customType: "boundary-state", data: { round } },
        {
          type: "compaction", summary: `Checkpoint ${round}: history was verified; continue implementation.`,
          firstKeptEntryId: retainNone ? null : lastMessage.id,
        },
        ...(continueRun ? [{
          type: "custom_message" as const, customType: "boundary-continuation", display: false,
          content: round < rounds ? "Read history.txt and finish the next planning round." : "Write result.txt containing done.",
        }] : []),
      ],
      continue: continueRun,
    };
  };

  pi.on("turn_end", (event, ctx) => {
    if (round >= rounds || event.outcome !== "completed" || event.message.role !== "assistant" || event.message.stopReason !== "stop") return;
    ready = true;
    if (boundary === "turn_end") return draft(event, ctx);
  });
  pi.on("agent_before_settle", (event, ctx) => {
    if (boundary === "agent_before_settle" && ready && event.outcome === "completed") return draft(event, ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    if (file) copyFileSync(file, join(ctx.cwd, "boundary-session-final.jsonl"));
    record(ctx, "shutdown", snapshot(ctx));
  });
}
