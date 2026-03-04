#!/usr/bin/env node
/**
 * postinstall:
 * 1) prune known legacy files left by overlay/dirty upgrades
 * 2) warn if duplicate openclaw-wecom directories exist
 */
import { readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "openclaw-wecom";
const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, "..");
const extensionsDir = join(
  process.env.OPENCLAW_STATE_DIR || process.env.CLAWDBOT_STATE_DIR || join(homedir(), ".openclaw"),
  "extensions",
);

// 历史版本中已删除，但在覆盖式升级中可能残留的文件
const LEGACY_RELATIVE_PATHS = [
  "wecom/src/commands.ts",
  "wecom/src/app/text-shortcuts.ts",
  "wecom/src/app/file-send.ts",
  "wecom/src/app/file-delivery.ts",
  "wecom/src/app/file-search.ts",
  "wecom/src/app/file-send-state.ts",
];

function isInsidePluginRoot(absPath) {
  const rel = relative(pluginRoot, absPath);
  return rel && !rel.startsWith("..") && !rel.includes(":");
}

function pruneLegacyFiles() {
  const removed = [];
  for (const relPath of LEGACY_RELATIVE_PATHS) {
    const absPath = resolve(pluginRoot, relPath);
    if (!isInsidePluginRoot(absPath)) continue;
    if (!existsSync(absPath)) continue;
    rmSync(absPath, { recursive: true, force: true });
    removed.push(relPath);
  }
  if (removed.length > 0) {
    console.log(
      `\n[${PLUGIN_ID}] 已清理历史残留文件（不会影响用户 Bot/App 配置）：\n` +
      removed.map((p) => `  - ${p}`).join("\n"),
    );
  }
}

try {
  pruneLegacyFiles();

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
