import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, renameSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { buildSessionContext, type SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";

/** A JSON object stored as one Pi session entry. */
export type SessionEntry = Record<string, any> & {
  type: string;
  id?: string;
  parentId?: string | null;
};

/** A parsed, validated Pi JSONL session. */
export interface ParsedSession {
  header: SessionEntry;
  entries: SessionEntry[];
  raw: Buffer;
  sourceSize: number;
  sourceMtimeMs: number;
}

/** A rebuilt session and the counts used in the preview. */
export interface SlimSession {
  header: SessionEntry;
  entries: SessionEntry[];
  originalCount: number;
  keptCount: number;
}

/** A validation failure with a short, payload-free explanation for the status line. */
export class SessionValidationError extends Error {
  readonly reason: string;

  constructor(message: string, reason = "the session history could not be validated") {
    super(message);
    this.name = "SessionValidationError";
    this.reason = reason;
  }
}

function fail(message: string, reason?: string): never {
  throw new SessionValidationError(message, reason);
}

/** Parse and validate a Pi v3 JSONL session. */
export function parseSession(raw: Buffer, sourcePath: string): ParsedSession {
  return parseSessionRecords(raw, sourcePath, false);
}

/** Only automatic input may contain old orphans; every replacement must pass strict parsing. */
function parseSessionRecords(raw: Buffer, sourcePath: string, allowMissingParents: boolean): ParsedSession {
  const text = raw.toString("utf8");
  if (!text.endsWith("\n")) fail(`${sourcePath}: JSONL must end with a newline`);
  const lines = text.split("\n").slice(0, -1);
  if (lines.length === 0) fail(`${sourcePath}: empty session`);

  const parsed = lines.map((line, index) => {
    if (!line.trim()) fail(`${sourcePath}: blank line ${index + 1}`);
    try {
      return JSON.parse(line) as SessionEntry;
    } catch (error) {
      fail(`${sourcePath}: invalid JSON at line ${index + 1}: ${String(error)}`);
    }
  });

  const header = parsed[0];
  if (header.type !== "session" || typeof header.id !== "string") {
    fail(`${sourcePath}: first line must be a session header with an id`);
  }

  const entries = parsed.slice(1);
  const ids = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      fail(`${sourcePath}: entry ${index + 2} has no id`);
    }
    if (ids.has(entry.id!)) fail(`${sourcePath}: duplicate entry id ${entry.id}`);
    ids.add(entry.id!);
    if (typeof entry.parentId !== "string" && entry.parentId !== null) {
      fail(`${sourcePath}: entry ${entry.id} has invalid parentId`);
    }
  }

  for (const entry of entries) {
    if (!allowMissingParents && entry.parentId !== null && !ids.has(entry.parentId!)) {
      fail(`${sourcePath}: entry ${entry.id} points to missing parent ${entry.parentId}`, "retained history has a missing parent");
    }
  }

  const sourceStat = { size: raw.byteLength, mtimeMs: 0 };
  return { header, entries, raw, sourceSize: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs };
}

/** A live session changed during a snapshot; automatic surgery can retry later. */
export class SessionChangedError extends Error {
  constructor(sourcePath: string) {
    super(`${sourcePath}: file changed while it was being read; retry when Pi is idle`);
    this.name = "SessionChangedError";
  }
}

/** Read a session while refusing files that change during the read. */
export async function readStableSession(sourcePath: string): Promise<ParsedSession> {
  const before = await stat(sourcePath);
  const raw = await readFile(sourcePath);
  const after = await stat(sourcePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new SessionChangedError(sourcePath);
  }
  const parsed = parseSession(raw, sourcePath);
  parsed.sourceSize = before.size;
  parsed.sourceMtimeMs = before.mtimeMs;
  return parsed;
}

/**
 * Read a session prefix that ends on a line boundary.
 *
 * Pi appends whole lines with synchronous writes, so a prefix read is a valid session snapshot and
 * everything appended after it can be carried over to the rewritten file unchanged. Old missing-parent
 * links are accepted only here; a commit must discard the damaged records, preserve Pi context and
 * produce a strictly valid replacement.
 */
export async function readSessionPrefix(sourcePath: string): Promise<ParsedSession> {
  const raw = await readFile(sourcePath);
  const end = raw.lastIndexOf(0x0a);
  if (end < 0) fail(`${sourcePath}: session has no complete line`);
  return parseSessionRecords(raw.subarray(0, end + 1), sourcePath, true);
}

/** Return the active branch, ending at the last stored entry. */
export function activeBranch(session: ParsedSession): SessionEntry[] {
  if (session.entries.length === 0) return [];
  const byId = new Map(session.entries.map((entry) => [entry.id!, entry]));
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = session.entries[session.entries.length - 1];

  while (current) {
    if (seen.has(current.id!)) fail(`session tree contains a cycle at ${current.id}`);
    seen.add(current.id!);
    path.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId!);
  }
  return path.reverse();
}

function freshId(used: Set<string>): string {
  let id = "";
  do id = randomBytes(4).toString("hex"); while (used.has(id));
  used.add(id);
  return id;
}

function retainedMessage(message: Record<string, any>): Record<string, any> | undefined {
  if (message?.role === "user" || message?.role === "system") return structuredClone(message);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;

  const content = message.content.flatMap((block: Record<string, any>): Array<Record<string, any>> => {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "thinking") return [{ type: "thinking", thinking: block.thinking }];
    return [];
  });
  if (content.length === 0) return undefined;

  const retained: Record<string, any> = { role: "assistant", content, stopReason: "stop" };
  for (const key of ["api", "provider", "model", "usage", "timestamp"]) {
    if (message[key] !== undefined) retained[key] = structuredClone(message[key]);
  }
  return retained;
}

/** Rebuild messages as plain transcript content. */
function retainedMessages(messages: Record<string, any>[]): Record<string, any>[] {
  return messages.flatMap((message) => {
    const retained = retainedMessage(message);
    return retained ? [retained] : [];
  });
}

function retainedEntry(entry: SessionEntry): SessionEntry | undefined {
  if (entry.type === "message") {
    const message = retainedMessage(entry.message);
    return message ? { ...structuredClone(entry), message } : undefined;
  }

  if (["model_change", "thinking_level_change", "session_info"].includes(entry.type)) {
    return structuredClone(entry);
  }

  if (entry.type === "compaction") {
    const compaction = structuredClone(entry);
    if (Array.isArray(compaction.retainedTail)) {
      compaction.retainedTail = retainedMessages(compaction.retainedTail);
    }
    return compaction;
  }

  return undefined;
}

/** One entry kept for the replacement session, with its position on the original branch. */
interface RetainedEntry {
  originalId: string;
  entry: SessionEntry;
  index: number;
}

/** Id of the newest compaction record on the branch. */
function lastCompactionId(branch: SessionEntry[]): string | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index].type === "compaction") return branch[index].id!;
  }
  return undefined;
}

/** Materialize Pi's latest system checkpoint for runtimes that restore tools only from raw messages. */
function branchWithSystemCheckpoint(session: ParsedSession): SessionEntry[] {
  const branch = structuredClone(activeBranch(session));
  let checkpointIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index].type === "compaction" && branch[index].systemMessage?.role === "system") {
      checkpointIndex = index;
      break;
    }
  }
  if (checkpointIndex < 0) return branch;

  const compaction = branch[checkpointIndex];
  const message = structuredClone(compaction.systemMessage);
  const active = new Set<string>((message.toolsAdded ?? []).map((tool: { name: string }) => tool.name));
  const mentioned = new Set<string>();
  for (const entry of branch.slice(0, checkpointIndex + 1)) {
    const system = entry.type === "compaction" ? entry.systemMessage : entry.message;
    if (system?.role !== "system") continue;
    for (const tool of [...(system.toolsAdded ?? []), ...(system.toolsRemoved ?? [])]) mentioned.add(tool.name);
  }
  // Pi distinguishes a removed extension tool from a tool it has never seen. Keep those tombstones.
  const removed = [...mentioned].filter((name) => !active.has(name)).map((name) => ({ name }));
  if (removed.length > 0) message.toolsRemoved = removed;

  const isSystem = (entry: SessionEntry) => entry.type === "message" && entry.message?.role === "system";
  let boundary = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  if (boundary < 0 || Array.isArray(compaction.retainedTail)) boundary = checkpointIndex;

  const usedIds = new Set(branch.map((entry) => entry.id!));
  const checkpoint: SessionEntry = {
    type: "message", id: freshId(usedIds), parentId: null, timestamp: compaction.timestamp, message,
  };
  // Keep a folded system boundary anchored to a record both rewrite modes retain.
  if (boundary < checkpointIndex && isSystem(branch[boundary])) compaction.firstKeptEntryId = checkpoint.id;
  return branch.flatMap((entry, index) => [
    ...(index === boundary ? [checkpoint] : []),
    ...(index < checkpointIndex && isSystem(entry) ? [] : [entry]),
  ]);
}

/** Relink kept entries into one linear chain and remap compaction boundaries. */
function relinkEntries(header: SessionEntry, retained: RetainedEntry[], originalCount: number): SlimSession {
  const mappedIds = new Map(retained.map(({ originalId, entry }) => [originalId, entry.id!]));

  for (const [position, current] of retained.entries()) {
    current.entry.parentId = position === 0 ? null : retained[position - 1].entry.id;
    if (current.entry.type !== "compaction" || !current.entry.firstKeptEntryId) continue;

    const mapped = mappedIds.get(current.entry.firstKeptEntryId);
    if (mapped) {
      current.entry.firstKeptEntryId = mapped;
      continue;
    }

    const next = retained.slice(position + 1).find((candidate) => candidate.index > current.index);
    if (!next) fail(`compaction ${current.originalId} points to no retained entry`);
    current.entry.firstKeptEntryId = next.entry.id;
  }

  return {
    header: structuredClone(header),
    entries: retained.map(({ entry }) => entry),
    originalCount,
    keptCount: retained.length,
  };
}

/**
 * Build the automatic replacement: keep everything the model can see, drop the rest.
 *
 * Pi rebuilds its context from the newest compaction: the summary plus every entry from that
 * compaction's first kept entry onwards. Nothing before that boundary is sent to the model, so
 * it is dropped here together with every older compaction record, except the controls and system
 * state needed to resume. The visible context is copied unchanged.
 */
export function buildCompactionCheckpoint(session: ParsedSession): SlimSession {
  const branch = branchWithSystemCheckpoint(session);
  let compactionIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index].type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  if (compactionIndex < 0) fail("session has no compaction checkpoint");

  const compaction = branch[compactionIndex];
  const hasMaterializedTail = Array.isArray(compaction.retainedTail);
  const firstKeptIndex = hasMaterializedTail || compaction.firstKeptEntryId === compaction.id
    ? compactionIndex
    : branch.findIndex((entry, index) => index < compactionIndex && entry.id === compaction.firstKeptEntryId);
  if (firstKeptIndex < 0) {
    fail(`compaction ${compaction.id} first kept entry ${String(compaction.firstKeptEntryId)} was not found`, "the compaction boundary is missing");
  }

  const controls = new Map<string, { index: number; entry: SessionEntry }>();
  const systemControls: Array<{ index: number; entry: SessionEntry }> = [];
  for (const [index, entry] of branch.slice(0, firstKeptIndex).entries()) {
    if (entry.type === "model_change") {
      controls.set("model", { index, entry: structuredClone(entry) });
    } else if (
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      typeof entry.message.provider === "string" &&
      typeof entry.message.model === "string"
    ) {
      controls.set("model", {
        index,
        entry: {
          type: "model_change",
          id: entry.id,
          parentId: entry.parentId,
          timestamp: entry.timestamp,
          provider: entry.message.provider,
          modelId: entry.message.model,
        },
      });
    } else if (entry.type === "thinking_level_change") {
      controls.set("thinking", { index, entry: structuredClone(entry) });
    } else if (entry.type === "session_info") {
      controls.set("session-info", { index, entry: structuredClone(entry) });
    } else if (entry.type === "message" && entry.message?.role === "system") {
      systemControls.push({ index, entry });
    }
  }

  const visible: Array<{ entry: SessionEntry; index: number }> = branch
    .slice(firstKeptIndex)
    .map((entry, offset) => ({ entry, index: firstKeptIndex + offset }))
    .filter(({ entry }) => entry.type !== "compaction" || entry.id === compaction.id);

  const ordered = [
    ...[...controls.values(), ...systemControls].sort((left, right) => left.index - right.index),
    ...visible,
  ];

  // Entries appended during the rewrite still refer to the original IDs.
  const retained: RetainedEntry[] = ordered.map(({ entry, index }) => {
    const originalId = entry.id!;
    entry.parentId = null;
    return { originalId, entry, index };
  });

  return relinkEntries(session.header, retained, session.entries.length);
}

/**
 * Build the manual replacement: a plain transcript of the active branch.
 *
 * Keeps user messages, assistant text and thinking, control records, and the newest compaction
 * record. Tool calls, tool results, and other entries are removed.
 */
export function buildSlimSession(session: ParsedSession): SlimSession {
  const branch = branchWithSystemCheckpoint(session);
  const newestCompaction = lastCompactionId(branch);
  const usedIds = new Set<string>();
  const retained: RetainedEntry[] = [];

  for (const [index, original] of branch.entries()) {
    if (original.type === "compaction" && original.id !== newestCompaction) continue;
    const entry = retainedEntry(original);
    if (!entry) continue;
    entry.id = freshId(usedIds);
    entry.parentId = null;
    retained.push({ originalId: original.id!, entry, index });
  }

  return relinkEntries(session.header, retained, session.entries.length);
}

/** Serialize a rebuilt session as newline-delimited JSON. */
export function serializeSession(session: SlimSession): Buffer {
  return Buffer.from(
    `${[session.header, ...session.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

async function writeAtomic(path: string, raw: Buffer, refuseExisting: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (refuseExisting) {
    try {
      await stat(path);
      fail(`${path}: destination already exists`);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(raw);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

const REWRITE_SUFFIX = /(?:\.(?:surgery|restored)-[^.]+)+$/u;
const MAX_BASE_BYTES = 120;

function sessionBaseName(sourcePath: string): string {
  const name = basename(sourcePath, ".jsonl").replace(REWRITE_SUFFIX, "");
  if (Buffer.byteLength(name) <= MAX_BASE_BYTES) return name;
  // Keep the tail: the session id is the unique, identifying part.
  return Buffer.from(name, "utf8").subarray(-MAX_BASE_BYTES).toString("utf8").replace(/^\uFFFD+/u, "");
}

/** Build the rewritten session path beside its source, replacing any earlier rewrite suffix. */
export function replacementSessionPath(sourcePath: string): string {
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const suffix = `surgery-${stamp}-${randomBytes(3).toString("hex")}.jsonl`;
  return join(dirname(sourcePath), `${sessionBaseName(sourcePath)}.${suffix}`);
}

/**
 * Replace the source file with the prepared replacement, carrying over bytes appended since the
 * prefix read.
 *
 * Every call here is synchronous on purpose: Pi appends session entries with synchronous writes, so
 * a synchronous commit cannot be interleaved with an append and no entry written by Pi is lost.
 * The source prefix and the live leaf must still match, and Pi must build the same context from both
 * files. This does not coordinate independent OS processes writing the same session.
 * Returns the number of carried-over bytes.
 */
export function commitInPlace(
  sourcePath: string,
  replacementPath: string,
  snapshot: ParsedSession,
  expectedLeaf: string | null,
): number {
  const current = readFileSync(sourcePath);
  if (!current.subarray(0, snapshot.raw.byteLength).equals(snapshot.raw)) {
    throw new SessionChangedError(sourcePath);
  }
  const original = parseSessionRecords(current, sourcePath, true);
  if ((original.entries.at(-1)?.id ?? null) !== expectedLeaf) throw new SessionChangedError(sourcePath);

  const appended = current.subarray(snapshot.raw.byteLength);
  const replacement = parseSession(Buffer.concat([readFileSync(replacementPath), appended]), replacementPath);
  // Pi stops at missing parents. Never guess a reconnection or retain a damaged visible record.
  const originalIds = new Set(original.entries.map((entry) => entry.id));
  const keptIds = new Set(replacement.entries.map((entry) => entry.id));
  for (const entry of original.entries) {
    if (entry.parentId !== null && !originalIds.has(entry.parentId!) && keptIds.has(entry.id)) {
      fail(`cannot trim visible entry ${entry.id} with a missing parent`, "retained history has a missing parent");
    }
  }
  // Detect cycles before asking Pi to traverse either tree.
  activeBranch(original);
  activeBranch(replacement);
  const context = (session: ParsedSession) => buildSessionContext(session.entries as PiSessionEntry[]);
  if (!isDeepStrictEqual(context(original), context(replacement))) {
    fail("replacement would change Pi's current context", "the replacement would change the current context");
  }
  if (appended.byteLength > 0) appendFileSync(replacementPath, appended);
  renameSync(replacementPath, sourcePath);
  return appended.byteLength;
}

/** Write a validated replacement session without touching the source. */
export async function writeReplacementSession(path: string, session: SlimSession): Promise<Buffer> {
  const raw = serializeSession(session);
  parseSession(raw, path);
  await writeAtomic(resolve(path), raw, true);
  return raw;
}
