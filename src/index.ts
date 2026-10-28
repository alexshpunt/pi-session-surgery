import { stat, unlink } from "node:fs/promises";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

import { loadSessionSurgeryConfig } from "./config.js";

import type { ParsedSession } from "./session.js";
import {
  activeBranch,
  buildCompactionCheckpoint,
  buildSlimSession,
  commitInPlace,
  readSessionPrefix,
  readStableSession,
  replacementSessionPath,
  serializeSession,
  SessionChangedError,
  SessionValidationError,
  writeReplacementSession,
} from "./session.js";

const COMMAND = "session-surgery";

/** Pi throws this when a captured extension context died together with its session. */
const STALE_CONTEXT_PREFIX = "This extension ctx is stale after session replacement or reload.";

/** How a prepared replacement session ended up. */
type SwitchOutcome = "switched" | "cancelled" | "deferred";

/**
 * The live session manager, which also moves the current session file.
 *
 * `ExtensionContext.sessionManager` is typed read-only, but the object behind it is the running
 * `SessionManager`. Automatic surgery rewrites the file the session already uses and then tells the
 * manager to re-read it, which keeps the session, its identity and the transcript untouched.
 */
interface LiveSessionManager {
  setSessionFile?: (sessionFile: string) => void;
}

function liveSessionManager(ctx: ExtensionContext): LiveSessionManager {
  return ctx.sessionManager as unknown as LiveSessionManager;
}

/** Whether this Pi lets an extension point the live session at a rewritten file. */
function supportsInPlaceTrim(ctx: ExtensionContext): boolean {
  return typeof liveSessionManager(ctx).setSessionFile === "function";
}

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
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
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
 * Drop the invisible history of the active session right after a compaction.
 *
 * Everything before the compaction's first kept entry is invisible to the model, so it is dropped
 * with the older compaction records. The part the model can see is copied unchanged.
 *
 * The file is rewritten in place and the live manager re-reads it, so the session keeps its file,
 * its ID and its transcript. Nothing is aborted, which is what lets this run the moment Pi reports
 * the compaction instead of at some later quiet moment.
 */
async function trimAfterCompaction(
  compactionId: string,
  ctx: ExtensionContext,
  isCurrent: () => boolean,
): Promise<void> {
  const sourcePath = ctx.sessionManager.getSessionFile();
  const sessionId = ctx.sessionManager.getSessionId();
  if (!sourcePath) throw new Error("The current session is not persisted to a file");

  const snapshot = await readSessionPrefix(sourcePath);
  if (!isCurrent() || ctx.sessionManager.getSessionFile() !== sourcePath ||
    ctx.sessionManager.getSessionId() !== sessionId ||
    ctx.sessionManager.getLeafId() !== (snapshot.entries.at(-1)?.id ?? null)) return;
  const branch = activeBranch(snapshot);
  if (!branch.some((entry) => entry.type === "compaction" && entry.id === compactionId)) {
    if (branch[0]?.parentId && snapshot.entries.some((entry) => entry.id === compactionId)) {
      throw new SessionValidationError("active history cannot reach its compaction", "retained history has a missing parent");
    }
    return;
  }

  const replacementPath = replacementSessionPath(sourcePath);
  try {
    const replacement = await writeReplacementSession(replacementPath, buildCompactionCheckpoint(snapshot));
    if (replacement.byteLength >= snapshot.sourceSize) return;
    if (!isCurrent() || ctx.sessionManager.getSessionFile() !== sourcePath ||
      ctx.sessionManager.getSessionId() !== sessionId || !supportsInPlaceTrim(ctx)) return;

    // No await between the final source/leaf/context checks, rename and live-manager reload.
    const carried = commitInPlace(sourcePath, replacementPath, snapshot, ctx.sessionManager.getLeafId());
    liveSessionManager(ctx).setSessionFile?.(sourcePath);
    ctx.ui.notify(
      `Compacted session trimmed: ${formatBytes(snapshot.sourceSize)} → ${formatBytes(replacement.byteLength + carried)}`,
      "info",
    );
  } finally {
    await removeReplacement(replacementPath);
  }
}

/** Register manual surgery and automatic post-compaction checkpointing. */
export default function register(pi: ExtensionAPI): void {
  let autoAfterCompaction = true;
  let generation = 0;
  let pending: { id: string; ctx: ExtensionContext; generation: number } | undefined;
  let trimming: Promise<void> | undefined;

  pi.on("session_start", (_event, ctx) => {
    generation += 1;
    pending = undefined;
    try {
      autoAfterCompaction = loadSessionSurgeryConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted()).autoAfterCompaction;
    } catch (error) {
      autoAfterCompaction = false;
      ctx.ui.notify(`Automatic session surgery disabled: ${String(error)}`, "error");
    }
    if (autoAfterCompaction && !supportsInPlaceTrim(ctx)) {
      autoAfterCompaction = false;
      ctx.ui.notify(
        "Automatic session surgery is off: this Pi cannot point the live session at a rewritten file.",
        "warning",
      );
    }
  });

  /** Coalesce waiting requests, keeping each context tied to its session lifetime. */
  const runPendingTrim = async (): Promise<void> => {
    while (pending) {
      const request = pending;
      pending = undefined;
      const isCurrent = () => generation === request.generation && autoAfterCompaction;
      try {
        await trimAfterCompaction(request.id, request.ctx, isCurrent);
      } catch (error) {
        if (!isCurrent() || isStaleContextError(error) || error instanceof SessionChangedError) continue;
        autoAfterCompaction = false;
        pending = undefined;
        const reason = error instanceof SessionValidationError ? error.reason : "the session file could not be read or rewritten";
        request.ctx.ui.notify(`Automatic session surgery is off for this session: ${reason}.`, "error");
      }
    }
  };

  pi.on("session_compact", async (event, ctx) => {
    if (!autoAfterCompaction) return;
    pending = { id: event.compactionEntry.id, ctx, generation };
    // Pi awaits this event before onComplete messages and the next turn can append.
    if (!trimming) trimming = runPendingTrim().finally(() => { trimming = undefined; });
    await trimming;
  });

  pi.on("session_shutdown", () => {
    generation += 1;
    pending = undefined;
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
}
