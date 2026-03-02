#!/usr/bin/env node
/**
 * Self-upgrade script for openclaw-wecom plugin.
 *
 * Usage:
 *   node scripts/upgrade.mjs          # upgrade to latest
 *   node scripts/upgrade.mjs 0.1.42   # upgrade to specific version
 */
import { execSync } from "node:child_process";
import { readdirSync, statSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_NAME = "@marshulll/openclaw-wecom";
const PLUGIN_ID = "openclaw-wecom";

// ── helpers ──

function readLocalVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    return pkg.version;
  } catch {
    return "unknown";
  }
}

async function fetchLatestVersion() {
  const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`);
  if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
  const data = await res.json();
  return data.version;
}

function resolveExtensionsDir() {
  return join(
    process.env.OPENCLAW_STATE_DIR || process.env.CLAWDBOT_STATE_DIR || join(homedir(), ".openclaw"),
    "extensions",
  );
}

function cleanDuplicates(extensionsDir) {
  let cleaned = 0;
  try {
    const entries = readdirSync(extensionsDir).filter(
      (name) => name.startsWith(PLUGIN_ID) && name !== PLUGIN_ID
        && statSync(join(extensionsDir, name)).isDirectory(),
    );
    for (const entry of entries) {
      const target = join(extensionsDir, entry);
      console.log(`  removing duplicate: ${target}`);
      rmSync(target, { recursive: true, force: true });
      cleaned++;
    }
  } catch { /* ignore */ }
  return cleaned;
}

// ── main ──

async function main() {
  const targetVersion = process.argv[2] || null;
  const localVersion = readLocalVersion();
  console.log(`current version: ${localVersion}`);

  let latest;
  if (targetVersion) {
    latest = targetVersion;
    console.log(`target version:  ${latest}`);
  } else {
    latest = await fetchLatestVersion();
    console.log(`latest version:  ${latest}`);
  }

  if (latest === localVersion && !targetVersion) {
    console.log("\nalready up to date.");
    return;
  }

  const extensionsDir = resolveExtensionsDir();
  const installDir = join(extensionsDir, PLUGIN_ID);
  const spec = targetVersion ? `${PKG_NAME}@${targetVersion}` : `${PKG_NAME}@latest`;

  console.log(`\nupgrading in ${installDir} ...`);
  execSync(`npm install ${spec} --omit=dev --install-strategy=nested`, {
    cwd: installDir,
    stdio: "inherit",
  });

  const cleaned = cleanDuplicates(extensionsDir);
  if (cleaned > 0) console.log(`\ncleaned ${cleaned} duplicate director${cleaned > 1 ? "ies" : "y"}.`);

  console.log(`\ndone. restart openclaw to load the new version.`);
}

main().catch((err) => {
  console.error(`upgrade failed: ${err.message}`);
  process.exit(1);
});
