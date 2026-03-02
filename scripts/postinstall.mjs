#!/usr/bin/env node
/**
 * postinstall: warn if duplicate openclaw-wecom directories exist
 * in the OpenClaw extensions folder.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PLUGIN_ID = "openclaw-wecom";
const extensionsDir = join(
  process.env.OPENCLAW_STATE_DIR || process.env.CLAWDBOT_STATE_DIR || join(homedir(), ".openclaw"),
  "extensions",
);

try {
  const entries = readdirSync(extensionsDir).filter(
    (name) => name.startsWith(PLUGIN_ID) && statSync(join(extensionsDir, name)).isDirectory(),
  );
  if (entries.length > 1) {
    console.warn(
      `\n⚠  检测到多个 ${PLUGIN_ID} 目录，可能导致 "duplicate plugin id" 冲突：\n` +
      entries.map((e) => `   - ${join(extensionsDir, e)}`).join("\n") +
      `\n   建议只保留 ${join(extensionsDir, PLUGIN_ID)}，删除其余副本。\n`,
    );
  }
} catch {
  // extensions dir doesn't exist yet — nothing to warn about
}
