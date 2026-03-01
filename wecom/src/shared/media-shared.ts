import { basename, extname, resolve as resolvePath } from "node:path";
import { readFile } from "node:fs/promises";

import { pickString } from "./string-utils.js";
import { fetchMediaFromUrl } from "../wecom-api.js";
import { resolveExtFromContentType, sanitizeFilename } from "../media-utils.js";
import type { ResolvedWecomAccount } from "../types.js";

export const MEDIA_TOO_LARGE_ERROR = "MEDIA_TOO_LARGE";

/**
 * 媒体类型常量映射
 */
export const MEDIA_LABELS: Record<string, string> = {
  image: "[image]",
  voice: "[voice]",
  video: "[video]",
  file: "[file]",
};

export const MEDIA_SENT_LABELS: Record<string, string> = {
  image: "[已发送图片]",
  voice: "[已发送语音]",
  video: "[已发送视频]",
  file: "[已发送文件]",
};

export const MEDIA_FALLBACK_EXT: Record<string, string> = {
  image: "jpg",
  voice: "amr",
  video: "mp4",
  file: "bin",
};

export type MediaType = "image" | "voice" | "video" | "file";

/**
 * 标准化媒体类型
 */
export function normalizeMediaType(raw?: string): MediaType | null {
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (value === "image" || value === "voice" || value === "video" || value === "file") return value;
  return null;
}

/**
 * 检查是否为媒体过大错误
 */
export function isMediaTooLargeError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === "string") return err.includes(MEDIA_TOO_LARGE_ERROR);
  if (typeof err === "object") {
    const anyErr = err as { code?: string; message?: string };
    if (anyErr.code === MEDIA_TOO_LARGE_ERROR) return true;
    if (typeof anyErr.message === "string" && anyErr.message.includes(MEDIA_TOO_LARGE_ERROR)) return true;
    if (typeof anyErr.message === "string" && anyErr.message.toLowerCase().includes("media too large")) return true;
  }
  return false;
}

/**
 * 根据扩展名获取 Content-Type
 */
export function resolveContentTypeFromExt(ext: string): string {
  const value = ext.toLowerCase();
  const mapping: Record<string, string> = {
    png: "image/png",
    gif: "image/gif",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    bmp: "image/bmp",
    amr: "audio/amr",
    wav: "audio/wav",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    pdf: "application/pdf",
    txt: "text/plain",
    csv: "text/csv",
    json: "application/json",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
  };
  return mapping[value] ?? "application/octet-stream";
}

/**
 * 根据 Content-Type 获取媒体类型
 */
export function resolveMediaTypeFromContentType(contentType: string): MediaType {
  const value = contentType.toLowerCase();
  if (value.startsWith("image/")) return "image";
  if (value.startsWith("audio/")) return "voice";
  if (value.startsWith("video/")) return "video";
  return "file";
}

/**
 * 移除 file:// 协议前缀并验证路径安全性
 */
export function stripFileProtocol(rawPath: string): string {
  const stripped = rawPath.startsWith("file://") ? rawPath.replace(/^file:\/\//, "") : rawPath;
  const resolved = resolvePath(stripped);
  // 阻止路径遍历到敏感系统目录
  const blocked = ["/etc", "/proc", "/sys", "/dev", "/var/run"];
  for (const prefix of blocked) {
    if (resolved === prefix || resolved.startsWith(prefix + "/")) {
      throw new Error(`Access denied: path ${resolved} is in a restricted directory`);
    }
  }
  return resolved;
}

/**
 * 解析 Base64 输入（支持 data URI）
 */
export function parseBase64Input(input: string): { data: string; mimeType?: string } {
  const match = input.match(/^data:([^;]+);base64,([\s\S]*)$/i);
  if (match) {
    return { data: match[2]!, mimeType: match[1] };
  }
  return { data: input };
}

/**
 * 获取媒体发送标签
 */
export function mediaSentLabel(type: string): string {
  return MEDIA_SENT_LABELS[type] ?? "[已发送媒体]";
}

/**
 * 获取媒体回退标签
 */
export function mediaFallbackLabel(msgtype: string): string {
  return MEDIA_LABELS[msgtype] ?? "[file]";
}

/**
 * 获取媒体回退扩展名
 */
export function mediaFallbackExt(msgtype: string): string {
  return MEDIA_FALLBACK_EXT[msgtype] ?? "bin";
}

/**
 * 出站媒体规格
 */
export type OutboundMediaSpec = {
  type?: string;
  url?: string;
  path?: string;
  base64?: string;
  filename?: string;
  mimeType?: string;
};

/**
 * 解析出站媒体规格
 */
export function resolveOutboundMediaSpec(payload: any): OutboundMediaSpec | null {
  if (!payload || typeof payload !== "object") return null;
  const mediaBlockRaw = payload.media ?? payload.attachment ?? payload.file ?? payload.files;
  const mediaBlock = Array.isArray(mediaBlockRaw) ? mediaBlockRaw[0] : mediaBlockRaw;
  const url = pickString(
    payload.mediaUrl,
    mediaBlock?.url,
    mediaBlock?.mediaUrl,
    mediaBlock?.fileUrl,
    mediaBlock?.file_url,
  );
  const path = pickString(
    payload.mediaPath,
    payload.filePath,
    mediaBlock?.path,
    mediaBlock?.filePath,
    mediaBlock?.localPath,
  );
  const base64 = pickString(
    payload.mediaBase64,
    payload.base64,
    mediaBlock?.base64,
    mediaBlock?.data,
  );
  const type = pickString(payload.mediaType, mediaBlock?.type, mediaBlock?.mediaType);
  const filename = pickString(payload.filename, payload.fileName, mediaBlock?.filename, mediaBlock?.fileName, mediaBlock?.name);
  const mimeType = pickString(payload.mimeType, payload.mediaMimeType, mediaBlock?.mimeType, mediaBlock?.contentType);
  let finalUrl = url;
  let finalPath = path;
  if (!finalPath && finalUrl && (finalUrl.startsWith("/") || finalUrl.startsWith("file://"))) {
    finalPath = finalUrl;
    finalUrl = "";
  }
  if (!finalUrl && !finalPath && !base64) return null;
  return { type, url: finalUrl, path: finalPath, base64, filename, mimeType };
}

/**
 * 加载出站媒体
 */
export async function loadOutboundMedia(params: {
  payload: any;
  account: ResolvedWecomAccount;
  maxBytes: number | undefined;
}): Promise<{ buffer: Buffer; contentType: string; type: MediaType; filename: string } | null> {
  const spec = resolveOutboundMediaSpec(params.payload);
  if (!spec) return null;

  let buffer: Buffer | null = null;
  let contentType = spec.mimeType ?? "";
  let filename = spec.filename ?? "";

  if (spec.base64) {
    const parsed = parseBase64Input(spec.base64);
    buffer = Buffer.from(parsed.data, "base64");
    if (!contentType && parsed.mimeType) contentType = parsed.mimeType;
  } else if (spec.path) {
    const resolvedPath = stripFileProtocol(spec.path);
    buffer = await readFile(resolvedPath);
    if (!filename) filename = basename(resolvedPath);
    if (!contentType) {
      const ext = extname(resolvedPath).replace(".", "");
      contentType = resolveContentTypeFromExt(ext);
    }
  } else if (spec.url) {
    const media = await fetchMediaFromUrl(spec.url, params.account, params.maxBytes);
    buffer = media.buffer;
    if (!contentType) contentType = media.contentType;
  }

  if (!buffer) return null;
  if (params.maxBytes && buffer.length > params.maxBytes) return null;

  const type = normalizeMediaType(spec.type) ?? resolveMediaTypeFromContentType(contentType || "application/octet-stream");
  const ext = resolveExtFromContentType(contentType || "application/octet-stream", type);
  const safeName = sanitizeFilename(filename, `${type}.${ext}`);

  return { buffer, contentType: contentType || resolveContentTypeFromExt(ext), type, filename: safeName };
}

/**
 * 构建入站媒体提示文本
 */
export function buildInboundMediaPrompt(msgtype: MediaType, filename?: string): string {
  if (msgtype === "image") {
    return "[用户发送了一张图片]\n\n请直接根据图片内容回复用户（图片将作为视觉输入提供；无需使用 Read 工具读取图片文件）。";
  }
  if (msgtype === "voice") return "[用户发送了一条语音消息]\n\n请根据语音内容回复用户。";
  if (msgtype === "video") return "[用户发送了一个视频文件]\n\n请根据视频内容回复用户。";
  const label = filename ? `用户发送了一个文件: ${filename}` : "用户发送了一个文件";
  return `[${label}]\n\n请根据文件内容回复用户。`;
}
