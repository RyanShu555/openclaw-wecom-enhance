import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { WecomWebhookTarget } from "../monitor.js";
import type { MediaCacheEntry } from "./cache-utils.js";
import { buildMediaCacheKey } from "./cache-utils.js";
import { formatErrorDetail } from "./string-utils.js";
import {
  buildInboundMediaPrompt,
  isMediaTooLargeError,
  mediaFallbackExt,
  type MediaType,
} from "./media-shared.js";
import {
  cleanupMediaDir,
  resolveExtFromContentType,
  resolveMediaMaxBytes,
  resolveMediaRetentionMs,
  resolveMediaTempDir,
  sanitizeFilename,
} from "../media-utils.js";
import {
  downloadWecomMedia,
  fetchMediaFromUrl,
} from "../wecom-api.js";
import { describeImageWithVision, resolveVisionConfig } from "../media-vision.js";
import {
  extractFileTextPreview,
  resolveAutoAudioConfig,
  resolveAutoFileConfig,
  resolveAutoVideoConfig,
  summarizeVideoWithVision,
  transcribeAudioWithOpenAI,
} from "../media-auto.js";

export type InboundMediaResult = {
  text: string;
  media?: {
    path: string;
    type: string;
    mimeType?: string;
    url?: string;
  };
};

type MediaTooLargeMessages = Record<MediaType, string>;

const MEDIA_TOO_LARGE: MediaTooLargeMessages = {
  image: "[图片过大，未处理]\n\n请发送更小的图片。",
  voice: "[语音消息过大，未处理]\n\n请发送更短的语音消息。",
  video: "[视频过大，未处理]\n\n请发送更小的视频。",
  file: "[文件过大，未处理]\n\n请发送更小的文件。",
};

const MEDIA_DOWNLOAD_FAILED: Record<MediaType, string> = {
  image: "[用户发送了一张图片，但下载失败]\n\n请告诉用户图片处理暂时不可用。",
  voice: "[用户发送了一条语音消息，但下载失败]\n\n请告诉用户语音处理暂时不可用。",
  video: "[用户发送了一个视频，但下载失败]\n\n请告诉用户视频处理暂时不可用。",
  file: "[用户发送了一个文件，但下载失败]\n\n请告诉用户文件处理暂时不可用。",
};

/**
 * 通用入站媒体处理管道：下载 → 保存 → 分析
 * bot 和 app 共用
 */
export async function processInboundMedia(params: {
  target: WecomWebhookTarget;
  msgtype: MediaType;
  mediaId?: string;
  url?: string;
  filename?: string;
  /** 获取缓存 */
  getCache: (key: string | null, retentionMs?: number) => Promise<MediaCacheEntry | null>;
  /** 存储缓存 */
  storeCache: (key: string | null, entry: MediaCacheEntry) => void;
}): Promise<InboundMediaResult> {
  const { target, msgtype, mediaId, url, filename } = params;

  if (!url && !mediaId) {
    return { text: buildInboundMediaPrompt(msgtype, filename) };
  }

  const maxBytes = resolveMediaMaxBytes(target);
  const retentionMs = resolveMediaRetentionMs(target);

  try {
    const cacheKey = buildMediaCacheKey({ mediaId, url });
    const cached = await params.getCache(cacheKey, retentionMs);
    if (cached) {
      return buildCachedResult({ cached, msgtype, filename, target });
    }

    // 下载媒体
    let buffer: Buffer | null = null;
    let contentType = "";
    if (url) {
      const media = await fetchMediaFromUrl(url, target.account, maxBytes);
      buffer = media.buffer;
      contentType = media.contentType;
    } else if (mediaId) {
      const media = await downloadWecomMedia({ account: target.account, mediaId, maxBytes });
      buffer = media.buffer;
      contentType = media.contentType;
    }

    if (!buffer) {
      return { text: buildInboundMediaPrompt(msgtype, filename) };
    }

    if (maxBytes && buffer.length > maxBytes) {
      return { text: MEDIA_TOO_LARGE[msgtype] };
    }

    // 保存到临时目录
    const tempDir = resolveMediaTempDir(target);
    await mkdir(tempDir, { recursive: true });
    await cleanupMediaDir(
      tempDir,
      target.account.config.media?.retentionHours,
      target.account.config.media?.cleanupOnStart,
    );

    const ext = resolveExtFromContentType(contentType, mediaFallbackExt(msgtype));

    // 按类型处理
    if (msgtype === "file") {
      return await processFile({ target, buffer, contentType, ext, filename, tempDir, cacheKey, storeCache: params.storeCache });
    }

    const tempPath = join(tempDir, `${msgtype}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
    await writeFile(tempPath, buffer);

    if (msgtype === "image") {
      return await processImage({ target, buffer, contentType, tempPath, url, cacheKey, storeCache: params.storeCache });
    }
    if (msgtype === "voice") {
      return await processVoice({ target, buffer, contentType, tempPath, url, cacheKey, storeCache: params.storeCache });
    }
    if (msgtype === "video") {
      return await processVideo({ target, buffer, contentType, tempPath, url, cacheKey, storeCache: params.storeCache });
    }

    return { text: buildInboundMediaPrompt(msgtype, filename) };
  } catch (err) {
    target.runtime.error?.(`wecom ${msgtype} download failed: ${formatErrorDetail(err)}`);
    if (isMediaTooLargeError(err)) {
      return { text: MEDIA_TOO_LARGE[msgtype] };
    }
    return { text: MEDIA_DOWNLOAD_FAILED[msgtype] };
  }
}

// --- 内部辅助函数 ---

async function buildCachedResult(params: {
  cached: MediaCacheEntry;
  msgtype: MediaType;
  filename?: string;
  target: WecomWebhookTarget;
}): Promise<InboundMediaResult> {
  const { cached, msgtype, filename } = params;
  const media = { path: cached.path, type: cached.type, mimeType: cached.mimeType, url: cached.url };

  if (msgtype === "image" && cached.summary) {
    return {
      text: `[用户发送了一张图片]\n\n[图片识别结果]\n${cached.summary}\n\n请根据识别结果回复用户（无需使用 Read 工具读取图片文件）。`,
      media,
    };
  }
  if (msgtype === "file") {
    const safeName = sanitizeFilename(filename || basename(cached.path), "file");
    const fileCfg = resolveAutoFileConfig(params.target.account.config);
    const preview = fileCfg
      ? await extractFileTextPreview({ path: cached.path, mimeType: cached.mimeType, cfg: fileCfg })
      : null;
    return {
      text: preview
        ? `[用户发送了一个文件: ${safeName}，已保存到: ${cached.path}]\n\n[文件内容预览]\n${preview}\n\n如需更多内容请使用 Read 工具。`
        : `[用户发送了一个文件: ${safeName}，已保存到: ${cached.path}]\n\n请使用 Read 工具查看这个文件的内容并回复用户。`,
      media,
    };
  }
  return { text: buildInboundMediaPrompt(msgtype, filename), media };
}

async function processFile(params: {
  target: WecomWebhookTarget;
  buffer: Buffer;
  contentType: string;
  ext: string;
  filename?: string;
  tempDir: string;
  cacheKey: string | null;
  storeCache: (key: string | null, entry: MediaCacheEntry) => void;
}): Promise<InboundMediaResult> {
  const { target, buffer, contentType, ext, filename, tempDir, cacheKey, storeCache } = params;
  const safeName = sanitizeFilename(filename || "", `file-${Date.now()}.${ext}`);
  const tempFilePath = join(tempDir, safeName);
  await writeFile(tempFilePath, buffer);
  const mimeType = contentType || "application/octet-stream";
  const media = { path: tempFilePath, type: "file" as const, mimeType };
  storeCache(cacheKey, { path: tempFilePath, type: "file", mimeType, createdAt: Date.now(), size: buffer.length });
  const fileCfg = resolveAutoFileConfig(target.account.config);
  const preview = fileCfg
    ? await extractFileTextPreview({ path: tempFilePath, mimeType, cfg: fileCfg })
    : null;
  return {
    text: preview
      ? `[用户发送了一个文件: ${safeName}，已保存到: ${tempFilePath}]\n\n[文件内容预览]\n${preview}\n\n如需更多内容请使用 Read 工具。`
      : `[用户发送了一个文件: ${safeName}，已保存到: ${tempFilePath}]\n\n请使用 Read 工具查看这个文件的内容并回复用户。`,
    media,
  };
}

async function processImage(params: {
  target: WecomWebhookTarget;
  buffer: Buffer;
  contentType: string;
  tempPath: string;
  url?: string;
  cacheKey: string | null;
  storeCache: (key: string | null, entry: MediaCacheEntry) => void;
}): Promise<InboundMediaResult> {
  const { target, buffer, contentType, tempPath, url, cacheKey, storeCache } = params;
  const mimeType = contentType || "image/jpeg";
  const media = { path: tempPath, type: "image" as const, mimeType, url };
  const visionConfig = resolveVisionConfig(target.account.config, target.config);
  const summary = visionConfig
    ? await describeImageWithVision({ config: visionConfig, buffer, mimeType })
    : null;
  storeCache(cacheKey, { path: tempPath, type: "image", mimeType, url, summary: summary ?? undefined, createdAt: Date.now(), size: buffer.length });
  return {
    text: summary
      ? `[用户发送了一张图片]\n\n[图片识别结果]\n${summary}\n\n请根据识别结果回复用户（无需使用 Read 工具读取图片文件）。`
      : buildInboundMediaPrompt("image"),
    media,
  };
}

async function processVoice(params: {
  target: WecomWebhookTarget;
  buffer: Buffer;
  contentType: string;
  tempPath: string;
  url?: string;
  cacheKey: string | null;
  storeCache: (key: string | null, entry: MediaCacheEntry) => void;
}): Promise<InboundMediaResult> {
  const { target, buffer, contentType, tempPath, url, cacheKey, storeCache } = params;
  const mimeType = contentType || "audio/amr";
  const media = { path: tempPath, type: "voice" as const, mimeType, url };
  storeCache(cacheKey, { path: tempPath, type: "voice", mimeType, createdAt: Date.now(), size: buffer.length });
  const audioCfg = resolveAutoAudioConfig(target.account.config);
  const transcript = audioCfg
    ? await transcribeAudioWithOpenAI({ cfg: audioCfg, buffer, mimeType })
    : null;
  return {
    text: transcript ? `[语音消息转写] ${transcript}` : buildInboundMediaPrompt("voice"),
    media,
  };
}

async function processVideo(params: {
  target: WecomWebhookTarget;
  buffer: Buffer;
  contentType: string;
  tempPath: string;
  url?: string;
  cacheKey: string | null;
  storeCache: (key: string | null, entry: MediaCacheEntry) => void;
}): Promise<InboundMediaResult> {
  const { target, buffer, contentType, tempPath, url, cacheKey, storeCache } = params;
  const mimeType = contentType || "video/mp4";
  const media = { path: tempPath, type: "video" as const, mimeType, url };
  storeCache(cacheKey, { path: tempPath, type: "video", mimeType, createdAt: Date.now(), size: buffer.length });
  const videoCfg = resolveAutoVideoConfig(target.account.config);
  const summary = videoCfg
    ? await summarizeVideoWithVision({ cfg: videoCfg, account: target.account.config, videoPath: tempPath })
    : null;
  return {
    text: summary
      ? `[用户发送了一个视频文件]\n\n[视频画面概述]\n${summary}\n\n请根据视频内容回复用户。`
      : buildInboundMediaPrompt("video"),
    media,
  };
}
