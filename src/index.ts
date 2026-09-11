import { unlink } from "node:fs/promises";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

import { loadSessionSurgeryConfig } from "./config.js";

import {
  activeBranch,
  buildCompactionCheckpoint,
  buildSlimSession,
  readStableSession,
  replacementSessionPath,
  serializeSession,
  writeReplacementSession,
} from "./session.js";

const COMMAND = "session-surgery";

const AUTO_COMMAND = "session-surgery-auto";

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

  const switched = await ctx.switchSession(replacementPath, {
    withSession: async (nextCtx) => {
      try {
        await unlink(preview.sourcePath);
      } catch (error) {
        nextCtx.ui.notify(`Slim session opened, but old file was not removed: ${String(error)}`, "warning");
        return;
      }
      nextCtx.ui.notify("Session slimmed", "info");
    },
  });

  if (switched.cancelled) {
    ctx.ui.notify(`Session switch cancelled. Replacement kept at ${replacementPath}`, "warning");
  }
}

/**
 * Fork the session right after a compaction.
 *
 * Everything before the compaction's first kept entry is invisible to the model, so it is dropped
 * with the older compaction records. The part the model can see is copied unchanged.
 */
async function runAutomaticCheckpoint(compactionId: string, ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle();
  const sourcePath = ctx.sessionManager.getSessionFile();
  if (!sourcePath) throw new Error("The current session is not persisted to a file");

  const parsed = await readStableSession(sourcePath);
  const branch = activeBranch(parsed);
  if (!branch.some((entry) => entry.type === "compaction" && entry.id === compactionId)) return;

  const replacementPath = replacementSessionPath(sourcePath);
  await writeReplacementSession(replacementPath, buildCompactionCheckpoint(parsed));
  SessionManager.open(replacementPath).buildSessionContext();

  const switched = await ctx.switchSession(replacementPath, {
    withSession: async (nextCtx) => {
      try {
        await unlink(sourcePath);
      } catch (error) {
        nextCtx.ui.notify(`Compacted session opened, but old file was not removed: ${String(error)}`, "warning");
        return;
      }
      nextCtx.ui.notify("Compacted session trimmed", "info");
    },
  });
  if (switched.cancelled) {
    ctx.ui.notify(`Automatic session switch cancelled. Replacement kept at ${replacementPath}`, "warning");
  }
}

/** Register manual surgery and automatic post-compaction checkpointing. */
export default function register(pi: ExtensionAPI): void {
  let autoAfterCompaction = true;
  let pendingCompactionId: string | undefined;
  let dispatchTimer: ReturnType<typeof setTimeout> | undefined;

  pi.on("session_start", (_event, ctx) => {
    try {
      autoAfterCompaction = loadSessionSurgeryConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted()).autoAfterCompaction;
    } catch (error) {
      autoAfterCompaction = false;
      ctx.ui.notify(`Automatic session surgery disabled: ${String(error)}`, "error");
    }
  });

  const scheduleAutomaticCheckpoint = (ctx: ExtensionContext): void => {
    if (dispatchTimer || !pendingCompactionId || ctx.hasPendingMessages()) return;
    dispatchTimer = setTimeout(() => {
      dispatchTimer = undefined;
      if (ctx.hasPendingMessages()) return;
      const compactionId = pendingCompactionId;
      if (!compactionId) return;
      pi.sendUserMessage(`/${AUTO_COMMAND} ${compactionId}`, {
        deliverAs: "followUp",
        expandPromptTemplates: true,
      });
      pendingCompactionId = undefined;
    }, 0);
  };

  pi.on("session_compact", (event, ctx) => {
    if (!autoAfterCompaction) return;
    pendingCompactionId = event.compactionEntry.id;
    if (ctx.isIdle()) scheduleAutomaticCheckpoint(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    scheduleAutomaticCheckpoint(ctx);
  });

  pi.on("session_shutdown", () => {
    if (dispatchTimer) clearTimeout(dispatchTimer);
    dispatchTimer = undefined;
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
      try {
        const compactionId = args.trim();
        if (!compactionId) throw new Error("missing compaction id");
        await runAutomaticCheckpoint(compactionId, ctx);
      } catch (error) {
        ctx.ui.notify(`Automatic session surgery failed: ${String(error)}`, "error");
      }
    },
  });
}
