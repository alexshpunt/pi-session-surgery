import { stat, unlink } from "node:fs/promises";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

import { loadSessionSurgeryConfig } from "./config.js";

import type { ParsedSession } from "./session.js";
import {
  activeBranch,
  buildCompactionCheckpoint,
  buildSlimSession,
  SessionChangedError,
  readStableSession,
  replacementSessionPath,
  serializeSession,
  writeReplacementSession,
} from "./session.js";

const COMMAND = "session-surgery";

const AUTO_COMMAND = "session-surgery-auto";

const MAX_IDLE_RETRIES = 2;
const IDLE_RETRY_DELAY_MS = 100;

/** Pi throws this when a captured extension context died together with its session. */
const STALE_CONTEXT_PREFIX = "This extension ctx is stale after session replacement or reload.";

/** How a prepared replacement session ended up. */
type SwitchOutcome = "switched" | "cancelled" | "deferred";

/** What the automatic trim still has to do. */
type AutoOutcome = SwitchOutcome | "obsolete";

function isStaleContextError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(STALE_CONTEXT_PREFIX);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function previewText(sourceBytes: number, slimBytes: number, kept: number, removed: number): string {
  const saved = sourceBytes - slimBytes;
  const percent = sourceBytes === 0 ? 0 : (saved / sourceBytes) * 100;
  return [
    `Current session: ${formatBytes(sourceBytes)}`,
    `After surgery: ${formatBytes(slimBytes)}`,
    `Estimated removal: ${formatBytes(saved)} (${percent.toFixed(1)}%)`,
    `Entries kept: ${kept}; removed: ${removed}`,
    "Keeps user messages, assistant text/thinking, control records, and the newest compaction.",
    "Removes tool calls, tool results, bash records, and extension entries.",
  ].join("\n");
}

async function previewSession(ctx: ExtensionCommandContext): Promise<{ sourcePath: string; text: string }> {
  const sourcePath = ctx.sessionManager.getSessionFile();
  if (!sourcePath) throw new Error("The current session is not persisted to a file");
  const parsed = await readStableSession(sourcePath);
  const slim = buildSlimSession(parsed);
  const slimBytes = serializeSession(slim).byteLength;
  return {
    sourcePath,
    text: previewText(parsed.raw.byteLength, slimBytes, slim.keptCount, slim.originalCount - slim.keptCount),
  };
}

/** True while the source file still holds exactly the bytes the replacement was copied from. */
async function sourceUnchanged(sourcePath: string, snapshot: ParsedSession): Promise<boolean> {
  const current = await stat(sourcePath);
  return current.size === snapshot.sourceSize && current.mtimeMs === snapshot.sourceMtimeMs;
}

/** Remove a prepared replacement that never became the active session. */
async function removeReplacement(replacementPath: string): Promise<void> {
  try {
    await unlink(replacementPath);
  } catch {
    // Cleanup only: a replacement that is already gone is fine.
  }
}

/**
 * Switch to a prepared replacement session, but only while the switch cannot destroy work.
 *
 * Pi activates a session by aborting the active turn and dropping queued messages, and the
 * replacement was copied from an earlier snapshot. When anything arrived since that snapshot, or
 * work is queued, the replacement is removed and the caller retries at a quieter moment.
 */
async function switchToReplacement(
  ctx: ExtensionCommandContext,
  sourcePath: string,
  replacementPath: string,
  snapshot: ParsedSession,
  trimmedMessage: string,
): Promise<SwitchOutcome> {
  let replacementStarted = false;
  let reportAfterSwitch: ((message: string, level: "info" | "warning") => void) | undefined;
  let report: { message: string; level: "info" | "warning" } | undefined;
  try {
    if (
      ctx.hasPendingMessages() ||
      !ctx.isIdle() ||
      !(await sourceUnchanged(sourcePath, snapshot)) ||
      ctx.hasPendingMessages() ||
      !ctx.isIdle()
    ) {
      await removeReplacement(replacementPath);
      return "deferred";
    }

    const switched = await ctx.switchSession(replacementPath, {
      withSession: async (nextCtx) => {
        replacementStarted = true;
        // Pi prints its own "Resumed session" status after this callback returns, so the trim
        // report is delivered below instead of here; the replaced context stays valid for it.
        reportAfterSwitch = (message, level) => nextCtx.ui.notify(message, level);
        try {
          await unlink(sourcePath);
        } catch (error) {
          report = {
            message: `Session replaced, but the old file was not removed: ${String(error)}`,
            level: "warning",
          };
          return;
        }
        const replacementBytes = await stat(replacementPath).then(
          (stats) => stats.size,
          () => undefined,
        );
        report = {
          message:
            replacementBytes === undefined
              ? `${trimmedMessage}; the session file was replaced`
              : `${trimmedMessage}: ${formatBytes(snapshot.sourceSize)} → ${formatBytes(replacementBytes)}; the session file was replaced`,
          level: "info",
        };
      },
    });

    if (switched.cancelled && !replacementStarted) {
      await removeReplacement(replacementPath);
      return "cancelled";
    }
    if (report && reportAfterSwitch) reportAfterSwitch(report.message, report.level);
    return "switched";
  } catch (error) {
    // A switch that never started leaves the prepared file behind; a started one owns it now.
    if (!replacementStarted) await removeReplacement(replacementPath);
    throw error;
  }
}

/** Rewrite the session into a plain transcript after the user confirms the preview. */
async function runSurgery(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle();
  const preview = await previewSession(ctx);
  if (!ctx.hasUI) throw new Error("Session surgery needs an interactive or RPC UI for confirmation");

  const confirmed = await ctx.ui.confirm(
    "Rewrite this session?",
    `${preview.text}\n\nThis creates a new session file and removes the old one after the switch. The removed tool history is gone for good.`,
  );
  if (!confirmed) {
    ctx.ui.notify("Session surgery cancelled", "info");
    return;
  }

  const parsed = await readStableSession(preview.sourcePath);
  const replacementPath = replacementSessionPath(preview.sourcePath);
  await writeReplacementSession(replacementPath, buildSlimSession(parsed));
  SessionManager.open(replacementPath).buildSessionContext();

  const outcome = await switchToReplacement(ctx, preview.sourcePath, replacementPath, parsed, "Session slimmed");
  if (outcome === "deferred") {
    ctx.ui.notify(
      "The session got busy or changed while the rewrite was prepared. Nothing was replaced; run /session-surgery again.",
      "warning",
    );
  }
  if (outcome === "cancelled") {
    ctx.ui.notify("Session switch cancelled. The prepared file was removed.", "warning");
  }
}

/**
 * Fork the session right after a compaction.
 *
 * Everything before the compaction's first kept entry is invisible to the model, so it is dropped
 * with the older compaction records. The part the model can see is copied unchanged.
 *
 * Returns "deferred" when the switch had to wait for a quieter moment, so the caller can keep the
 * request and retry after the next settle.
 */
async function runAutomaticCheckpoint(compactionId: string, ctx: ExtensionCommandContext): Promise<AutoOutcome> {
  await ctx.waitForIdle();
  if (!ctx.isIdle() || ctx.hasPendingMessages()) return "deferred";
  const sourcePath = ctx.sessionManager.getSessionFile();
  if (!sourcePath) throw new Error("The current session is not persisted to a file");

  const parsed = await readStableSession(sourcePath);
  const branch = activeBranch(parsed);
  if (!branch.some((entry) => entry.type === "compaction" && entry.id === compactionId)) return "obsolete";

  const replacementPath = replacementSessionPath(sourcePath);
  await writeReplacementSession(replacementPath, buildCompactionCheckpoint(parsed));
  SessionManager.open(replacementPath).buildSessionContext();

  return switchToReplacement(ctx, sourcePath, replacementPath, parsed, "Compacted session trimmed");
}

/** Register manual surgery and automatic post-compaction checkpointing. */
export default function register(pi: ExtensionAPI): void {
  let autoAfterCompaction = true;
  let pendingCompactionId: string | undefined;
  let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
  let runningCompactionId: string | undefined;
  let nextDispatch: { ctx: ExtensionContext; delayMs: number } | undefined;
  // A short idle race gets another chance without polling a persistently changing file forever.
  let idleRetriesRemaining = MAX_IDLE_RETRIES;

  /** Keep a trim request for the next settle instead of losing it. */
  const keepPendingCompaction = (compactionId: string): void => {
    if (compactionId) pendingCompactionId ??= compactionId;
  };

  /** False while Pi is busy, work is queued, or this context died with a replaced session. */
  const canTrimNow = (ctx: ExtensionContext): boolean => {
    try {
      return ctx.isIdle() && !ctx.hasPendingMessages();
    } catch (error) {
      if (isStaleContextError(error)) return false;
      throw error;
    }
  };

  pi.on("session_start", (_event, ctx) => {
    try {
      autoAfterCompaction = loadSessionSurgeryConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted()).autoAfterCompaction;
    } catch (error) {
      autoAfterCompaction = false;
      ctx.ui.notify(`Automatic session surgery disabled: ${String(error)}`, "error");
    }
  });

  const scheduleAutomaticCheckpoint = (ctx: ExtensionContext, delayMs = 0): void => {
    // session_compact fires before Pi clears its compaction state. Check idle in the timer,
    // after onComplete has had a chance to start a continuation, not in this event handler.
    if (runningCompactionId) {
      // A new lifecycle event takes precedence over an older attempt's delayed retry.
      if (!nextDispatch || delayMs === 0) nextDispatch = { ctx, delayMs };
      return;
    }
    if (dispatchTimer || !pendingCompactionId) return;
    dispatchTimer = setTimeout(() => {
      dispatchTimer = undefined;
      try {
        if (runningCompactionId) {
          scheduleAutomaticCheckpoint(ctx, delayMs);
          return;
        }
        const compactionId = pendingCompactionId;
        if (!compactionId || !canTrimNow(ctx)) return;
        pi.sendUserMessage(`/${AUTO_COMMAND} ${compactionId}`, {
          deliverAs: "followUp",
          expandPromptTemplates: true,
        });
        pendingCompactionId = undefined;
      } catch (error) {
        // A replaced session invalidates this context; the next settle retries with a fresh one.
        if (!isStaleContextError(error)) throw error;
      }
    }, delayMs);
  };

  const retryAutomaticCheckpoint = (compactionId: string, ctx: ExtensionContext): void => {
    keepPendingCompaction(compactionId);
    if (idleRetriesRemaining > 0 && canTrimNow(ctx)) {
      idleRetriesRemaining--;
      scheduleAutomaticCheckpoint(ctx, IDLE_RETRY_DELAY_MS);
    }
  };

  pi.on("session_compact", (event, ctx) => {
    if (!autoAfterCompaction) return;
    pendingCompactionId = event.compactionEntry.id;
    idleRetriesRemaining = MAX_IDLE_RETRIES;
    scheduleAutomaticCheckpoint(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    idleRetriesRemaining = MAX_IDLE_RETRIES;
    scheduleAutomaticCheckpoint(ctx);
  });

  pi.on("session_shutdown", () => {
    if (dispatchTimer) clearTimeout(dispatchTimer);
    dispatchTimer = undefined;
    nextDispatch = undefined;
  });

  pi.registerCommand(COMMAND, {
    description: "Safely rewrite the current Pi session after showing a preview",
    handler: async (_args, ctx) => {
      try {
        await runSurgery(ctx);
      } catch (error) {
        ctx.ui.notify(`Session surgery failed: ${String(error)}`, "error");
      }
    },
  });

  pi.registerCommand(AUTO_COMMAND, {
    description: "Internal command that trims a successfully compacted session",
    handler: async (args, ctx) => {
      const compactionId = args.trim();
      if (runningCompactionId) {
        if (compactionId && compactionId !== runningCompactionId) {
          keepPendingCompaction(compactionId);
          scheduleAutomaticCheckpoint(ctx);
        }
        return;
      }
      runningCompactionId = compactionId;
      try {
        if (!compactionId) throw new Error("missing compaction id");
        const outcome = await runAutomaticCheckpoint(compactionId, ctx);
        if (outcome === "deferred") retryAutomaticCheckpoint(compactionId, ctx);
      } catch (error) {
        if (isStaleContextError(error)) {
          // The session was replaced while the trim was in flight. The replacement session keeps
          // the same compaction, so retry there instead of reporting a failure.
          keepPendingCompaction(compactionId);
          return;
        }
        if (error instanceof SessionChangedError) {
          retryAutomaticCheckpoint(compactionId, ctx);
          return;
        }
        ctx.ui.notify(`Automatic session surgery failed: ${String(error)}`, "error");
      } finally {
        runningCompactionId = undefined;
        const next = nextDispatch;
        nextDispatch = undefined;
        if (next) scheduleAutomaticCheckpoint(next.ctx, next.delayMs);
      }
    },
  });
}
