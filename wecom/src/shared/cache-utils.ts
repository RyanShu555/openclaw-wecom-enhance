import crypto from "node:crypto";
import { stat } from "node:fs/promises";

import type { MediaType } from "./media-shared.js";

export const MEDIA_CACHE_MAX_ENTRIES = 200;

export type MediaCacheEntry = {
  path: string;
  type: MediaType;
  mimeType?: string;
  url?: string;
  summary?: string;
  createdAt: number;
  size: number;
};

/**
 * 计算字符串的 SHA1 哈希
 */
export function hashKey(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

/**
 * 构建媒体缓存 key
 */
export function buildMediaCacheKey(params: { mediaId?: string; url?: string; base64?: string }): string | null {
  if (params.mediaId) return `media:${params.mediaId}`;
  if (params.url) return `url:${hashKey(params.url)}`;
  if (params.base64) return `b64:${hashKey(params.base64)}`;
  return null;
}

/**
 * 清理媒体缓存（移除超出限制的旧条目）
 */
export function pruneMediaCache(cache: Map<string, MediaCacheEntry>, maxEntries = MEDIA_CACHE_MAX_ENTRIES): void {
  if (cache.size <= maxEntries) return;
  const entries = Array.from(cache.entries())
    .sort((a, b) => a[1].createdAt - b[1].createdAt);
  const excess = entries.length - maxEntries;
  for (let i = 0; i < excess; i += 1) {
    cache.delete(entries[i]![0]);
  }
}

/**
 * 获取缓存的媒体
 */
export async function getCachedMedia(
  cache: Map<string, MediaCacheEntry>,
  key: string | null,
  retentionMs?: number,
): Promise<MediaCacheEntry | null> {
  if (!key) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  if (retentionMs && Date.now() - entry.createdAt > retentionMs) {
    cache.delete(key);
    return null;
  }
  try {
    await stat(entry.path);
  } catch {
    cache.delete(key);
    return null;
  }
  return entry;
}

/**
 * 存储媒体到缓存
 */
export function storeCachedMedia(
  cache: Map<string, MediaCacheEntry>,
  key: string | null,
  entry: MediaCacheEntry,
  maxEntries = MEDIA_CACHE_MAX_ENTRIES,
): void {
  if (!key) return;
  cache.set(key, entry);
  pruneMediaCache(cache, maxEntries);
}
