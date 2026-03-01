import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { WecomWebhookTarget } from "./monitor.js";

const cleanupExecuted = new Map<string, number>();
const CLEANUP_CACHE_MAX = 200;
const CLEANUP_CACHE_TTL_MS = 24 * 3600 * 1000;

export function resolveExtFromContentType(contentType: string, fallback: string): string {
  if (!contentType) return fallback;
  const ct = contentType.toLowerCase();
  const mapping: Record<string, string> = {
    "image/png": "png",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "audio/amr": "amr",
    "audio/wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
  };
  // 精确匹配（去掉参数部分如 charset）
  const base = ct.split(";")[0]!.trim();
  if (mapping[base]) return mapping[base];
  return fallback;
}

export async function cleanupMediaDir(
  dir: string,
  retentionHours?: number,
  cleanupOnStart?: boolean,
): Promise<void> {
  if (cleanupOnStart === false) return;
  if (!retentionHours || retentionHours <= 0) return;
  const now = Date.now();
  const lastRun = cleanupExecuted.get(dir);
  if (lastRun && now - lastRun < CLEANUP_CACHE_TTL_MS) return;
  cleanupExecuted.set(dir, now);
  // 防止缓存无限增长
  if (cleanupExecuted.size > CLEANUP_CACHE_MAX) {
    const oldest = Array.from(cleanupExecuted.entries()).sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < oldest.length - CLEANUP_CACHE_MAX; i++) {
      cleanupExecuted.delete(oldest[i]![0]);
    }
  }
  const cutoff = Date.now() - retentionHours * 3600 * 1000;
  try {
    const entries = await readdir(dir);
    await Promise.all(entries.map(async (entry) => {
      const full = join(dir, entry);
      try {
        const info = await stat(full);
        if (info.isFile() && info.mtimeMs < cutoff) {
          await rm(full, { force: true });
        }
      } catch {
        // ignore
      }
    }));
  } catch {
    // ignore
  }
}

export function resolveMediaTempDir(target: WecomWebhookTarget): string {
  const raw = target.account.config.media?.tempDir?.trim();
  if (!raw) return join(tmpdir(), "openclaw-wecom");
  const resolved = resolve(raw);
  // 阻止配置指向敏感系统目录
  const blocked = ["/etc", "/proc", "/sys", "/dev", "/var/run"];
  for (const prefix of blocked) {
    if (resolved === prefix || resolved.startsWith(prefix + "/")) {
      return join(tmpdir(), "openclaw-wecom");
    }
  }
  return resolved;
}

export function resolveMediaMaxBytes(target: WecomWebhookTarget): number | undefined {
  const maxBytes = target.account.config.media?.maxBytes;
  return typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : undefined;
}

export function resolveMediaRetentionMs(target: WecomWebhookTarget): number | undefined {
  const hours = target.account.config.media?.retentionHours;
  return typeof hours === "number" && hours > 0 ? hours * 3600 * 1000 : undefined;
}

export function sanitizeFilename(name: string, fallback: string): string {
  const base = name.split(/[/\\\\]/).pop() ?? "";
  const trimmed = base.trim();
  // 阻止 .. 路径遍历
  if (trimmed === ".." || trimmed === "." || trimmed.includes("..")) {
    return fallback;
  }
  const safe = trimmed
    .replace(/[^\w.\-() \u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const finalName = safe.slice(0, 120);
  return finalName || fallback;
}
