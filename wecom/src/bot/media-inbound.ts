import { fetchMediaFromUrl } from "../wecom-api.js";
import { resolveMediaMaxBytes } from "../media-utils.js";
import { decryptWecomMedia } from "../crypto.js";
import type { WecomWebhookTarget } from "../monitor.js";
import type { WecomInboundMessage } from "../types.js";
import {
  buildMediaCacheKey,
  getCachedMedia as getCachedMediaShared,
  MEDIA_CACHE_MAX_ENTRIES,
  type MediaCacheEntry,
  storeCachedMedia as storeCachedMediaShared,
} from "../shared/cache-utils.js";
import {
  buildInboundMediaPrompt,
  mediaFallbackExt,
  mediaFallbackLabel,
  parseBase64Input,
} from "../shared/media-shared.js";
import { pickString, formatErrorDetail } from "../shared/string-utils.js";
import { processInboundMedia } from "../shared/media-inbound.js";

const mediaCache = new Map<string, MediaCacheEntry>();

type InboundMedia = {
  path: string;
  type: string;
  mimeType?: string;
  url?: string;
};

export type InboundBody = {
  text: string;
  media?: InboundMedia;
};

async function getBotCachedMedia(key: string | null, retentionMs?: number): Promise<MediaCacheEntry | null> {
  return getCachedMediaShared(mediaCache, key, retentionMs);
}

function storeBotCachedMedia(key: string | null, entry: MediaCacheEntry): void {
  storeCachedMediaShared(mediaCache, key, entry, MEDIA_CACHE_MAX_ENTRIES);
}

function resolveBotMediaUrl(msg: any, msgtype: "image" | "voice" | "video" | "file"): string {
  if (!msg || typeof msg !== "object") return "";
  const block = msg[msgtype] ?? {};
  if (msgtype === "image") {
    return pickString(
      block.url,
      block.imageUrl,
      block.image_url,
      block.picurl,
      block.picUrl,
      block.pic_url,
      msg.imageUrl,
      msg.image_url,
      msg.picurl,
      msg.picUrl,
      msg.pic_url,
      msg.url,
    );
  }
  if (msgtype === "voice") {
    return pickString(
      block.url,
      block.fileurl,
      block.fileUrl,
      block.file_url,
      block.downloadUrl,
      block.download_url,
      block.mediaUrl,
      block.media_url,
      msg.voiceUrl,
      msg.voice_url,
      msg.url,
    );
  }
  if (msgtype === "video") {
    return pickString(
      block.url,
      block.fileurl,
      block.fileUrl,
      block.file_url,
      block.downloadUrl,
      block.download_url,
      block.mediaUrl,
      block.media_url,
      msg.videoUrl,
      msg.video_url,
      msg.url,
    );
  }
  return pickString(
    block.url,
    block.fileurl,
    block.fileUrl,
    block.file_url,
    block.downloadUrl,
    block.download_url,
    block.mediaUrl,
    block.media_url,
    msg.fileUrl,
    msg.file_url,
    msg.url,
  );
}

function resolveBotMediaBase64(msg: any, msgtype: "image" | "voice" | "video" | "file"): string {
  if (!msg || typeof msg !== "object") return "";
  const block = msg[msgtype] ?? {};
  return pickString(
    block.base64,
    block.base64Data,
    block.data,
    msg.base64,
    msg.data,
  );
}

function resolveBotMediaId(msg: any, msgtype: "image" | "voice" | "video" | "file"): string {
  if (!msg || typeof msg !== "object") return "";
  const block = msg[msgtype] ?? {};
  return pickString(
    block.media_id,
    block.mediaId,
    block.mediaid,
    block.mediaID,
    msg.media_id,
    msg.mediaId,
    msg.mediaid,
    msg.mediaID,
  );
}

function resolveBotMediaFilename(msg: any): string {
  if (!msg || typeof msg !== "object") return "";
  const block = msg.file ?? {};
  return pickString(
    block.filename,
    block.fileName,
    block.name,
    block.file_name,
    block.file,
    msg.filename,
    msg.fileName,
    msg.name,
  );
}

async function buildBotMediaMessage(params: {
  target: WecomWebhookTarget;
  msgtype: "image" | "voice" | "video" | "file";
  url?: string;
  base64?: string;
  mediaId?: string;
  filename?: string;
}): Promise<InboundBody> {
  const { target, msgtype, url, base64, mediaId, filename } = params;

  const fallbackLabel = mediaFallbackLabel(msgtype);

  if (!url && !base64 && !mediaId) return { text: fallbackLabel };
  const hasAppCreds = Boolean(target.account.corpId && target.account.corpSecret && target.account.agentId);
  if (!url && !base64 && mediaId && !hasAppCreds) {
    return {
      text: "[用户发送了媒体，但当前仅配置 Bot]\n\n未配置 App 凭据，无法下载或识别媒体内容。请补充 corpId/corpSecret/agentId。",
    };
  }

  // Bot 特有：base64 数据需要先解码为 URL 或直接处理
  // Bot 特有：URL 数据可能需要 AES 解密
  // 对于这些情况，先预处理为 URL，再交给 processInboundMedia
  let resolvedUrl = url;

  if (base64) {
    // base64 模式：bot 独有，需要先保存到临时文件再处理
    const parsed = parseBase64Input(base64);
    const buffer = Buffer.from(parsed.data, "base64");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { resolveMediaTempDir, resolveExtFromContentType, sanitizeFilename } = await import("../media-utils.js");
    let contentType = parsed.mimeType ?? "";
    if (!contentType) {
      if (msgtype === "image") contentType = "image/jpeg";
      else if (msgtype === "voice") contentType = "audio/amr";
      else if (msgtype === "video") contentType = "video/mp4";
      else contentType = "application/octet-stream";
    }
    const tempDir = resolveMediaTempDir(target);
    await mkdir(tempDir, { recursive: true });
    const ext = resolveExtFromContentType(contentType, mediaFallbackExt(msgtype));
    const safeName = msgtype === "file"
      ? sanitizeFilename(filename || "", `file-${Date.now()}.${ext}`)
      : `${msgtype}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const tempPath = join(tempDir, safeName);
    await writeFile(tempPath, buffer);
    const media = { path: tempPath, type: msgtype, mimeType: contentType, url };
    storeBotCachedMedia(buildMediaCacheKey({ base64 }), {
      path: tempPath, type: msgtype, mimeType: contentType, createdAt: Date.now(), size: buffer.length,
    });
    return { text: buildInboundMediaPrompt(msgtype, filename), media };
  }

  if (resolvedUrl) {
    // Bot URL 可能需要 AES 解密 — 先下载并解密，保存后走 processInboundMedia 的缓存路径
    const aesKey = target.account.encodingAESKey || "";
    if (aesKey) {
      try {
        const maxBytes = resolveMediaMaxBytes(target);
        const fetched = await fetchMediaFromUrl(resolvedUrl, target.account, maxBytes);
        const decrypted = decryptWecomMedia({ encodingAESKey: aesKey, buffer: fetched.buffer });
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { resolveMediaTempDir, resolveExtFromContentType, cleanupMediaDir } = await import("../media-utils.js");
        let contentType = "";
        if (msgtype === "image") contentType = "image/jpeg";
        else if (msgtype === "voice") contentType = "audio/amr";
        else if (msgtype === "video") contentType = "video/mp4";
        else contentType = "application/octet-stream";
        const tempDir = resolveMediaTempDir(target);
        await mkdir(tempDir, { recursive: true });
        await cleanupMediaDir(tempDir, target.account.config.media?.retentionHours, target.account.config.media?.cleanupOnStart);
        const ext = resolveExtFromContentType(contentType, mediaFallbackExt(msgtype));
        const tempPath = join(tempDir, `${msgtype}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
        await writeFile(tempPath, decrypted);
        const media = { path: tempPath, type: msgtype, mimeType: contentType, url: resolvedUrl };
        storeBotCachedMedia(buildMediaCacheKey({ url: resolvedUrl }), {
          path: tempPath, type: msgtype, mimeType: contentType, url: resolvedUrl, createdAt: Date.now(), size: decrypted.length,
        });
        return { text: buildInboundMediaPrompt(msgtype, filename), media };
      } catch (err) {
        target.runtime.error?.(`[${target.account.accountId}] wecom bot media decrypt failed: ${formatErrorDetail(err)}`);
        // 解密失败，回退到普通 URL 下载
      }
    }
  }

  // 标准路径：URL 或 mediaId，交给共享的 processInboundMedia
  return processInboundMedia({
    target,
    msgtype,
    mediaId: mediaId || undefined,
    url: resolvedUrl || undefined,
    filename,
    getCache: getBotCachedMedia,
    storeCache: storeBotCachedMedia,
  });
}

export async function buildInboundBody(params: { target: WecomWebhookTarget; msg: WecomInboundMessage }): Promise<InboundBody> {
  const { target, msg } = params;
  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  if (msgtype === "text") {
    const content = (msg as any).text?.content;
    return { text: typeof content === "string" ? content : "" };
  }
  if (msgtype === "voice") {
    const content = (msg as any).voice?.content;
    if (typeof content === "string" && content.trim()) return { text: content.trim() };
    const recognition = pickString(
      (msg as any).voice?.recognition,
      (msg as any).voice?.text,
      (msg as any).voice?.transcript,
      (msg as any).recognition,
    );
    if (recognition) return { text: recognition };
    const url = resolveBotMediaUrl(msg as any, "voice");
    const base64 = resolveBotMediaBase64(msg as any, "voice");
    const mediaId = resolveBotMediaId(msg as any, "voice");
    return await buildBotMediaMessage({ target, msgtype: "voice", url, base64, mediaId });
  }
  if (msgtype === "mixed") {
    const items = (msg as any).mixed?.msg_item;
    if (Array.isArray(items)) {
      const text = items
        .map((item: any) => {
          const t = String(item?.msgtype ?? "").toLowerCase();
          if (t === "text") return String(item?.text?.content ?? "");
          if (t === "image") return `[image] ${String(item?.image?.url ?? "").trim()}`.trim();
          return `[${t || "item"}]`;
        })
        .filter((part: string) => Boolean(part && part.trim()))
        .join("\n");
      return { text };
    }
    return { text: "[mixed]" };
  }
  if (msgtype === "image") {
    const url = resolveBotMediaUrl(msg as any, "image");
    const base64 = resolveBotMediaBase64(msg as any, "image");
    const mediaId = resolveBotMediaId(msg as any, "image");
    return await buildBotMediaMessage({ target, msgtype: "image", url, base64, mediaId });
  }
  if (msgtype === "file") {
    const url = resolveBotMediaUrl(msg as any, "file");
    const base64 = resolveBotMediaBase64(msg as any, "file");
    const mediaId = resolveBotMediaId(msg as any, "file");
    const filename = resolveBotMediaFilename(msg as any);
    return await buildBotMediaMessage({ target, msgtype: "file", url, base64, mediaId, filename });
  }
  if (msgtype === "video") {
    const url = resolveBotMediaUrl(msg as any, "video");
    const base64 = resolveBotMediaBase64(msg as any, "video");
    const mediaId = resolveBotMediaId(msg as any, "video");
    return await buildBotMediaMessage({ target, msgtype: "video", url, base64, mediaId });
  }
  if (msgtype === "event") {
    const eventtype = String((msg as any).event?.eventtype ?? "").trim();
    return { text: eventtype ? `[event] ${eventtype}` : "[event]" };
  }
  if (msgtype === "stream") {
    const id = String((msg as any).stream?.id ?? "").trim();
    return { text: id ? `[stream_refresh] ${id}` : "[stream_refresh]" };
  }
  return { text: msgtype ? `[${msgtype}]` : "" };
}
