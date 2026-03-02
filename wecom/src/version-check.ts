import type { PluginRuntime } from "openclaw/plugin-sdk";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_NAME = "@marshulll/openclaw-wecom";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let lastCheckAt = 0;

function readLocalVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

function isNewer(remote: string, local: string): boolean {
  const r = remote.split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (l[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (l[i] ?? 0)) return false;
  }
  return false;
}

export function checkForUpdates(runtime: PluginRuntime): void {
  const now = Date.now();
  if (now - lastCheckAt < CHECK_INTERVAL_MS) return;
  lastCheckAt = now;

  // fire-and-forget, never block startup
  fetchLatestVersion().then((latest) => {
    if (!latest) return;
    const local = readLocalVersion();
    if (isNewer(latest, local)) {
      runtime.info?.(
        `[openclaw-wecom] 新版本 ${latest} 可用（当前 ${local}）。` +
        `运行 node <extensions>/openclaw-wecom/scripts/upgrade.mjs 升级`,
      );
    }
  }).catch(() => { /* silently ignore */ });
}
