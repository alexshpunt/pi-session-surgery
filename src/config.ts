import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/** User settings for automatic session checkpoint surgery. */
export interface SessionSurgeryConfig {
  autoAfterCompaction: boolean;
}

const DEFAULT_CONFIG: SessionSurgeryConfig = { autoAfterCompaction: true };

function readConfig(path: string): Partial<SessionSurgeryConfig> {
  if (!existsSync(path)) return {};

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: cannot read session surgery config: ${String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: session surgery config must be a JSON object`);
  }

  const config = value as Record<string, unknown>;
  if (config.autoAfterCompaction !== undefined && typeof config.autoAfterCompaction !== "boolean") {
    throw new Error(`${path}: autoAfterCompaction must be true or false`);
  }
  return config as Partial<SessionSurgeryConfig>;
}

/** Load the global setting and an optional trusted-project override. */
export function loadSessionSurgeryConfig(
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
): SessionSurgeryConfig {
  const globalConfig = readConfig(join(agentDir, "extensions", "session-surgery.json"));
  const projectConfig = projectTrusted
    ? readConfig(join(cwd, CONFIG_DIR_NAME, "session-surgery.json"))
    : {};

  return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
}
