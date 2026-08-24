import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  appendSurgeryMetadata,
  buildSlimSession,
  createBackup,
  defaultBackupRoot,
  latestSurgeryMetadata,
  readBackupManifest,
  readStableSession,
  restoreBackup,
  serializeSession,
  writeReplacementSession,
} from "./session.js";

const COMMAND = "session-surgery";

function resolveUserPath(value: string): string {
  return value === "~" || value.startsWith("~/")
    ? join(homedir(), value.slice(2))
    : resolve(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function outputPath(sourcePath: string): string {
  const name = basename(sourcePath, ".jsonl");
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  return join(dirname(sourcePath), `${name}.surgery-${stamp}-${randomBytes(3).toString("hex")}.jsonl`);
}

function previewText(sourceBytes: number, slimBytes: number, kept: number, removed: number): string {
  const saved = sourceBytes - slimBytes;
  const percent = sourceBytes === 0 ? 0 : (saved / sourceBytes) * 100;
  return [
    `Current session: ${formatBytes(sourceBytes)}`,
    `After surgery: ${formatBytes(slimBytes)}`,
    `Estimated removal: ${formatBytes(saved)} (${percent.toFixed(1)}%)`,
    `Entries kept: ${kept}; removed: ${removed}`,
    "Keeps user messages, assistant text/thinking, control records, and compaction.",
    "Removes tool calls/results, bash records, and extension entries.",
    `Backup: ${defaultBackupRoot()}/<session-id>/...`,
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

async function runSurgery(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle();
  const preview = await previewSession(ctx);
  if (!ctx.hasUI) throw new Error("Session surgery needs an interactive or RPC UI for confirmation");

  const confirmed = await ctx.ui.confirm(
    "Rewrite this session?",
    `${preview.text}\n\nThis creates a new session and removes the old session file after the switch. The original is backed up first.`,
  );
  if (!confirmed) {
    ctx.ui.notify("Session surgery cancelled", "info");
    return;
  }

  const parsed = await readStableSession(preview.sourcePath);
  const baseSlim = buildSlimSession(parsed);
  const backup = await createBackup(preview.sourcePath, parsed);
  const slim = appendSurgeryMetadata(baseSlim, {
    version: 1,
    operation: "slim",
    backupManifest: backup.manifestPath,
    backupSha256: backup.sha256,
    sourceSessionId: parsed.header.id!,
    createdAt: backup.createdAt,
  });
  const replacementPath = outputPath(preview.sourcePath);
  await writeReplacementSession(replacementPath, slim);
  const replacement = SessionManager.open(replacementPath);
  replacement.buildSessionContext();

  const switched = await ctx.switchSession(replacementPath, {
    withSession: async (nextCtx) => {
      try {
        await unlink(preview.sourcePath);
      } catch (error) {
        nextCtx.ui.notify(`Slim session opened, but old file was not removed: ${String(error)}`, "warning");
        return;
      }
      nextCtx.ui.notify(`Session slimmed. Backup: ${backup.manifestPath}`, "info");
    },
  });

  if (switched.cancelled) {
    ctx.ui.notify(`Session switch cancelled. Replacement kept at ${replacementPath}`, "warning");
  }
}

async function runRestore(args: string, ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle();
  const sourcePath = ctx.sessionManager.getSessionFile();
  if (!sourcePath) throw new Error("The current session is not persisted to a file");

  const current = await readStableSession(sourcePath);
  const requestedPath = args.trim();
  const metadata = requestedPath ? undefined : latestSurgeryMetadata(current);
  const manifestPath = requestedPath ? resolveUserPath(requestedPath) : metadata?.backupManifest;
  if (!manifestPath) {
    throw new Error("No session-surgery backup is linked to this session; pass a manifest path explicitly");
  }

  const manifest = await readBackupManifest(manifestPath);
  if (!ctx.hasUI) throw new Error("Session restore needs an interactive or RPC UI for confirmation");
  const confirmed = await ctx.ui.confirm(
    "Restore the parent session?",
    `Backup: ${manifestPath}\nOriginal session: ${manifest.sessionId}\nSize: ${formatBytes(manifest.byteCount)}\n\nThis creates a new session and leaves the backup untouched.`,
  );
  if (!confirmed) {
    ctx.ui.notify("Session restore cancelled", "info");
    return;
  }

  const replacementPath = outputPath(sourcePath).replace(".surgery-", ".restored-");
  await restoreBackup(manifestPath, replacementPath);
  SessionManager.open(replacementPath).buildSessionContext();

  const switched = await ctx.switchSession(replacementPath, {
    withSession: async (nextCtx) => {
      nextCtx.ui.notify(`Restored session opened. Backup remains at ${manifestPath}`, "info");
    },
  });
  if (switched.cancelled) ctx.ui.notify(`Restore session kept at ${replacementPath}`, "warning");
}

/** Register the destructive session rewrite and restore commands. */
export default function register(pi: ExtensionAPI): void {
  pi.registerCommand(COMMAND, {
    description: "Safely rewrite the current Pi session after showing a preview",
    handler: async (args, ctx) => {
      try {
        const commandArgs = args.trim();
        if (commandArgs === "restore") return await runRestore("", ctx);
        if (commandArgs.startsWith("restore ")) return await runRestore(commandArgs.slice("restore ".length), ctx);
        return await runSurgery(ctx);
      } catch (error) {
        ctx.ui.notify(`Session surgery failed: ${String(error)}`, "error");
      }
    },
  });
}
