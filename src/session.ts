import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

/** The immutable copy and manifest created before a rewrite. */
export interface BackupResult {
  backupPath: string;
  manifestPath: string;
  sha256: string;
  createdAt: string;
}

/** Metadata that links a slim session to its immediate source backup. */
export interface SurgeryMetadata {
  version: 1;
  operation: "slim";
  backupManifest: string;
  backupSha256: string;
  sourceSessionId: string;
  createdAt: string;
}

/** The manifest written beside an immutable session backup. */
export interface BackupManifest {
  version: 1;
  sourcePath: string;
  backupPath: string;
  sessionId: string;
  createdAt: string;
  byteCount: number;
  sha256: string;
}

/** The custom entry type used for non-context restore links. */
export const SURGERY_CUSTOM_TYPE = "pi-session-surgery";
const BACKUP_ROOT = join(homedir(), ".pi", "agent", "session-backups");

function fail(message: string): never {
  throw new Error(message);
}

function surgeryMetadataFrom(value: unknown): SurgeryMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  if (
    data.version !== 1 ||
    data.operation !== "slim" ||
    typeof data.backupManifest !== "string" ||
    typeof data.backupSha256 !== "string" ||
    typeof data.sourceSessionId !== "string" ||
    typeof data.createdAt !== "string"
  ) return undefined;
  return data as unknown as SurgeryMetadata;
}
/** Parse and validate a Pi v3 JSONL session. */
export function parseSession(raw: Buffer, sourcePath: string): ParsedSession {
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
    if (entry.parentId !== null && !ids.has(entry.parentId!)) {
      fail(`${sourcePath}: entry ${entry.id} points to missing parent ${entry.parentId}`);
    }
  }

  const sourceStat = { size: raw.byteLength, mtimeMs: 0 };
  return { header, entries, raw, sourceSize: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs };
}

/** Read a session while refusing files that change during the read. */
export async function readStableSession(sourcePath: string): Promise<ParsedSession> {
  const before = await stat(sourcePath);
  const raw = await readFile(sourcePath);
  const after = await stat(sourcePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    fail(`${sourcePath}: file changed while it was being read; stop Pi and retry`);
  }
  const parsed = parseSession(raw, sourcePath);
  parsed.sourceSize = before.size;
  parsed.sourceMtimeMs = before.mtimeMs;
  return parsed;
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

function retainedEntry(entry: SessionEntry): SessionEntry | undefined {
  if (entry.type === "message") {
    if (entry.message?.role === "user") return structuredClone(entry);
    if (entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) return undefined;
    const content = entry.message.content.filter((block: SessionEntry) =>
      block.type === "text" || block.type === "thinking",
    );
    if (content.length === 0) return undefined;
    return { ...structuredClone(entry), message: { ...structuredClone(entry.message), content } };
  }

  if (entry.type === "custom" && entry.customType === SURGERY_CUSTOM_TYPE && surgeryMetadataFrom(entry.data)) {
    return structuredClone(entry);
  }

  if (["model_change", "thinking_level_change", "session_info", "compaction"].includes(entry.type)) {
    return structuredClone(entry);
  }
  return undefined;
}

/** Build a new linear session while preserving conversation and compaction state. */
export function buildSlimSession(session: ParsedSession): SlimSession {
  const branch = activeBranch(session);
  const mappedIds = new Map<string, string>();
  const usedIds = new Set<string>();
  const retained: Array<{ original: SessionEntry; entry: SessionEntry; index: number }> = [];

  for (const [index, original] of branch.entries()) {
    const entry = retainedEntry(original);
    if (!entry) continue;
    entry.id = freshId(usedIds);
    entry.parentId = null;
    mappedIds.set(original.id!, entry.id!);
    retained.push({ original, entry, index });
  }

  for (let index = 0; index < retained.length; index += 1) {
    const current = retained[index];
    current.entry.parentId = index === 0 ? null : retained[index - 1].entry.id;
    if (current.entry.type !== "compaction" || !current.entry.firstKeptEntryId) continue;

    const mapped = mappedIds.get(current.entry.firstKeptEntryId);
    if (mapped) {
      current.entry.firstKeptEntryId = mapped;
      continue;
    }

    const next = retained.slice(index + 1).find((candidate) => candidate.index > current.index);
    if (!next) fail(`compaction ${current.original.id} points to no retained entry`);
    current.entry.firstKeptEntryId = next.entry.id;
  }

  return {
    header: structuredClone(session.header),
    entries: retained.map(({ entry }) => entry),
    originalCount: session.entries.length,
    keptCount: retained.length,
  };
}

/** Return the latest surgery metadata on the active branch. */
export function latestSurgeryMetadata(session: ParsedSession): SurgeryMetadata | undefined {
  for (const entry of [...activeBranch(session)].reverse()) {
    if (entry.type !== "custom" || entry.customType !== SURGERY_CUSTOM_TYPE) continue;
    const metadata = surgeryMetadataFrom(entry.data);
    if (metadata) return metadata;
  }
  return undefined;
}

/** Append the link to the backup that produced a replacement session. */
export function appendSurgeryMetadata(session: SlimSession, metadata: SurgeryMetadata): SlimSession {
  const usedIds = new Set(session.entries.flatMap((entry) => entry.id ? [entry.id] : []));
  const entry: SessionEntry = {
    type: "custom",
    id: freshId(usedIds),
    parentId: session.entries.at(-1)?.id ?? null,
    timestamp: metadata.createdAt,
    customType: SURGERY_CUSTOM_TYPE,
    data: structuredClone(metadata),
  };
  return {
    ...session,
    entries: [...session.entries, entry],
    keptCount: session.keptCount + 1,
  };
}

/** Serialize a rebuilt session as newline-delimited JSON. */
export function serializeSession(session: SlimSession): Buffer {
  return Buffer.from(
    `${[session.header, ...session.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

function sha256(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
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

  const temporary = join(dirname(path), `.${path.split("/").pop()}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
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

/** Create a private, immutable backup of the source session. */
export async function createBackup(
  sourcePath: string,
  session: ParsedSession,
  backupRoot = BACKUP_ROOT,
): Promise<BackupResult> {
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
  const directory = join(backupRoot, String(session.header.id), `${stamp}-${randomBytes(3).toString("hex")}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const backupPath = join(directory, "original.jsonl");
  const manifestPath = join(directory, "manifest.json");
  const digest = sha256(session.raw);
  const createdAt = new Date().toISOString();
  await writeFile(backupPath, session.raw, { flag: "wx", mode: 0o600 });
  if (sha256(await readFile(backupPath)) !== digest) fail("backup checksum mismatch");

  await writeFile(
    manifestPath,
    `${JSON.stringify({ version: 1, sourcePath, backupPath, sessionId: session.header.id, createdAt, byteCount: session.raw.byteLength, sha256: digest }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return { backupPath, manifestPath, sha256: digest, createdAt };
}

/** Write a validated replacement session without touching the source. */
export async function writeReplacementSession(path: string, session: SlimSession): Promise<Buffer> {
  const raw = serializeSession(session);
  parseSession(raw, path);
  await writeAtomic(resolve(path), raw, true);
  return raw;
}

/** Read and validate a backup manifest without changing any files. */
export async function readBackupManifest(manifestPath: string): Promise<BackupManifest> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  if (
    manifest.version !== 1 ||
    typeof manifest.sourcePath !== "string" ||
    typeof manifest.backupPath !== "string" ||
    typeof manifest.sessionId !== "string" ||
    typeof manifest.createdAt !== "string" ||
    typeof manifest.byteCount !== "number" ||
    typeof manifest.sha256 !== "string"
  ) fail(`${manifestPath}: invalid backup manifest`);
  return manifest as unknown as BackupManifest;
}

/** Restore a backup to a new or existing target without changing the backup. */
export async function restoreBackup(manifestPath: string, targetPath: string): Promise<void> {
  const manifest = await readBackupManifest(manifestPath);
  const backup = await readFile(manifest.backupPath);
  if (sha256(backup) !== manifest.sha256) fail(`${manifest.backupPath}: checksum mismatch`);
  await writeAtomic(resolve(targetPath), backup, false);
  if (sha256(await readFile(resolve(targetPath))) !== manifest.sha256) fail(`${targetPath}: restore checksum mismatch`);
  if (sha256(await readFile(manifest.backupPath)) !== manifest.sha256) fail(`${manifest.backupPath}: backup changed during restore`);
}

/** Return the default hidden backup location used by the extension. */
export function defaultBackupRoot(): string {
  return BACKUP_ROOT;
}
