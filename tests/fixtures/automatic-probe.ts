import { appendFileSync, copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { buildSessionContext, type ExtensionAPI, type ExtensionContext, type SessionManager } from "@earendil-works/pi-coding-agent";

import register from "../../src/index.js";

/** Drive the real Pi and observe both sides of the awaited compaction handler. */
export default function probe(pi: ExtensionAPI): void {
  let remainingCompactions = 0;
  let injected = false;
  let beforeContext: ReturnType<typeof buildSessionContext> | undefined;

  const record = (ctx: ExtensionContext, event: string, data: object = {}): void => {
    appendFileSync(join(ctx.cwd, "surgery-probe.jsonl"), JSON.stringify({ event, ...data }) + "\n");
  };
  const contextOf = (ctx: ExtensionContext) => buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
  const snapshot = (ctx: ExtensionContext) => {
    const file = ctx.sessionManager.getSessionFile();
    const entries = file && existsSync(file)
      ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)).slice(1)
      : [];
    const ids = new Set(entries.map((entry) => entry.id));
    return {
      file,
      sessionId: ctx.sessionManager.getSessionId(),
      leaf: ctx.sessionManager.getLeafId(),
      size: file && existsSync(file) ? statSync(file).size : 0,
      compactions: entries.filter((entry) => entry.type === "compaction").length,
      orphans: entries.filter((entry) => entry.parentId !== null && !ids.has(entry.parentId)).length,
    };
  };

  // Register before surgery so these measurements precede its awaited rewrite.
  pi.on("session_compact", (_event, ctx) => {
    if (!injected && process.env.PI_SURGERY_TEST_ORPHAN === "1") {
      // This intentional corruption is restricted to the test's private workspace and session.
      if (!ctx.cwd.startsWith(join(tmpdir(), "pi-surgery-integration-"))) throw new Error("Not a private test workspace");
      const file = ctx.sessionManager.getSessionFile();
      if (!file) throw new Error("Test session is not persisted");
      const entries = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      if (entries[1]?.parentId !== null) throw new Error("Test session does not start with a root entry");
      const context = contextOf(ctx);
      const orphanId = "probe-historical-orphan";
      entries[1].parentId = orphanId;
      entries.splice(1, 0, {
        type: "custom_message", id: orphanId, parentId: "probe-absent-parent",
        timestamp: entries[0].timestamp, customType: "historical-damage",
        content: "Old history already covered by the checkpoint.", display: true,
      });
      writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      (ctx.sessionManager as SessionManager).setSessionFile(file);
      record(ctx, "orphan-injected", { contextUnchanged: isDeepStrictEqual(context, contextOf(ctx)) });
      injected = true;
    }
    beforeContext = structuredClone(contextOf(ctx));
    record(ctx, "before-trim", snapshot(ctx));
  });

  register(pi);

  pi.on("session_start", (event, ctx) => {
    if (event.reason === "resume") record(ctx, "resumed");
    if (event.reason !== "startup") return;
    remainingCompactions = Number(process.env.PI_SURGERY_TEST_COMPACTIONS ?? 1);
    record(ctx, "startup", snapshot(ctx));
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (remainingCompactions <= 0) return;
    remainingCompactions -= 1;
    record(ctx, "compact-request");
    ctx.compact({
      onComplete: () => {
        pi.sendMessage({
          customType: "probe-continuation",
          content: remainingCompactions > 0
            ? "Read history.txt again and finish planning."
            : "Write result.txt containing done.",
          display: true,
        }, { triggerTurn: true });
      },
    });
  });

  pi.on("session_compact", (_event, ctx) => {
    record(ctx, "compacted", {
      ...snapshot(ctx),
      contextUnchanged: isDeepStrictEqual(beforeContext, contextOf(ctx)),
    });
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (existsSync(join(ctx.cwd, "result.txt"))) record(ctx, "result-written");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const file = ctx.sessionManager.getSessionFile();
    if (file) copyFileSync(file, join(ctx.cwd, "session-final.jsonl"));
    record(ctx, "shutdown", snapshot(ctx));
  });
}
