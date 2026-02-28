import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";

import type { PluginRuntime } from "openclaw/plugin-sdk";

import type { WecomWebhookTarget } from "./monitor.js";
import type { ResolvedWecomAccount, WecomInboundMessage } from "./types.js";
import {
  computeWecomMsgSignature,
  decryptWecomEncrypted,
  decryptWecomMedia,
  encryptWecomPlaintext,
  verifyWecomSignature,
} from "./crypto.js";
import {
  fetchMediaFromUrl,
} from "./wecom-api.js";
import { getWecomRuntime } from "./runtime.js";
import {
  resolveMediaMaxBytes,
} from "./media-utils.js";
import {
  jsonOk,
  readJsonBody,
  resolveQueryParams,
  resolveSignatureParam,
} from "./shared/http-utils.js";
import {
  pickString,
  truncateUtf8Bytes,
} from "./shared/string-utils.js";
import {
  buildInboundMediaPrompt,
  mediaFallbackLabel,
  parseBase64Input,
} from "./shared/media-shared.js";
import {
  buildMediaCacheKey,
  type MediaCacheEntry,
  MEDIA_CACHE_MAX_ENTRIES,
} from "./shared/cache-utils.js";
import { dispatchOutboundMedia } from "./shared/dispatch-media.js";
import { buildAgentContext } from "./shared/agent-context.js";
import { processInboundMedia } from "./shared/media-inbound.js";
import { ConversationQueue, type PendingBatch, DEFAULT_DEBOUNCE_MS } from "./shared/conversation-queue.js";
import { sendWecomText } from "./wecom-api.js";

const STREAM_TTL_MS = 10 * 60 * 1000;
const STREAM_MAX_BYTES = 20_480;
const STREAM_MAX_ENTRIES = 500;
const DEDUPE_TTL_MS = 2 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 2_000;
const BOT_WINDOW_MS = 6 * 60 * 1000;
const BOT_SWITCH_MARGIN_MS = 30 * 1000;
const mediaCache = new Map<string, MediaCacheEntry>();

type StreamState = {
  streamId: string;
  msgid?: string;
  responseUrl?: string;
  conversationKey?: string;
  userId?: string;
  chatType?: "group" | "direct";
  chatId?: string;
  createdAt: number;
  updatedAt: number;
  started: boolean;
  finished: boolean;
  error?: string;
  content: string;
  // 超时降级相关
  fallbackMode?: "media" | "timeout" | "error";
  dmContent?: string;
};

type InboundMedia = {
  path: string;
  type: string;
  mimeType?: string;
  url?: string;
};

type InboundBody = {
  text: string;
  media?: InboundMedia;
};

const streams = new Map<string, StreamState>();
const msgidToStreamId = new Map<string, string>();
const recentEncrypts = new Map<string, { ts: number; streamId?: string }>();

// ── 会话级防抖队列 ──
type BotBatchMeta = {
  target: WecomWebhookTarget;
  msg: WecomInboundMessage;
  streamId: string;
  nonce: string;
  timestamp: string;
};
const botQueue = new ConversationQueue<BotBatchMeta>();
botQueue.setFlushHandler((batch) => void flushBotBatch(batch));

async function flushBotBatch(batch: PendingBatch<BotBatchMeta>): Promise<void> {
  const { meta } = batch;
  const { target, streamId } = meta;
  // 聚合多条消息为一条
  const mergedText = batch.contents.join("\n");
  const mergedMsg: WecomInboundMessage = {
    ...meta.msg,
    msgtype: "text",
    text: { content: mergedText },
  };
  try {
    let core: PluginRuntime | null = null;
    try { core = getWecomRuntime(); } catch { /* runtime not ready */ }
    if (core) {
      streams.get(streamId)!.started = true;
      const enrichedTarget: WecomWebhookTarget = { ...target, core };
      await startAgentForStream({ target: enrichedTarget, accountId: target.account.accountId, msg: mergedMsg, streamId });
    } else {
      const state = streams.get(streamId);
      if (state) { state.finished = true; state.updatedAt = Date.now(); }
    }
  } catch (err) {
    const state = streams.get(streamId);
    if (state) {
      state.error = err instanceof Error ? err.message : String(err);
      state.content = state.content || `Error: ${state.error}`;
      state.finished = true;
      state.updatedAt = Date.now();
    }
    target.runtime.error?.(`[${target.account.accountId}] wecom agent failed: ${String(err)}`);
  } finally {
    botQueue.onBatchFinished(batch.conversationKey);
  }
}

// ── 超时降级辅助 ──
function shouldFallbackToDm(state: StreamState): boolean {
  if (state.fallbackMode) return false; // 已经在降级中
  return Date.now() - state.createdAt >= BOT_WINDOW_MS - BOT_SWITCH_MARGIN_MS;
}

function appendDmContent(state: StreamState, text: string): void {
  const next = state.dmContent ? `${state.dmContent}\n\n${text}`.trim() : text.trim();
  state.dmContent = truncateUtf8Bytes(next, 200_000);
}

async function sendAgentDmText(params: {
  account: ResolvedWecomAccount;
  userId: string;
  text: string;
}): Promise<void> {
  await sendWecomText({ account: params.account, toUser: params.userId, text: params.text });
}

function buildFallbackPrompt(params: {
  kind: "media" | "timeout" | "error";
  agentConfigured: boolean;
  userId?: string;
}): string {
  if (!params.agentConfigured) {
    return "需要通过应用私信发送，但管理员尚未配置企业微信自建应用（Agent）通道。请联系管理员配置后再试。";
  }
  if (!params.userId) {
    return "需要通过应用私信兜底发送，但未能识别触发者 userid。请联系管理员排查配置。";
  }
  if (params.kind === "timeout") {
    return "内容较长，为避免超时，后续内容将通过应用私信发送给你。";
  }
  if (params.kind === "media") {
    return "已生成文件，将通过应用私信发送给你。";
  }
  return "交付出现异常，已尝试通过应用私信发送给你。";
}

import { getCachedMedia as getCachedMediaShared, storeCachedMedia as storeCachedMediaShared } from "./shared/cache-utils.js";

async function getBotCachedMedia(key: string | null, retentionMs?: number): Promise<MediaCacheEntry | null> {
  return getCachedMediaShared(mediaCache, key, retentionMs);
}

function storeBotCachedMedia(key: string | null, entry: MediaCacheEntry): void {
  storeCachedMediaShared(mediaCache, key, entry, MEDIA_CACHE_MAX_ENTRIES);
}

function pruneStreams(): void {
  const cutoff = Date.now() - STREAM_TTL_MS;
  for (const [id, state] of streams.entries()) {
    if (state.updatedAt < cutoff) {
      streams.delete(id);
    }
  }
  for (const [msgid, id] of msgidToStreamId.entries()) {
    if (!streams.has(id)) {
      msgidToStreamId.delete(msgid);
    }
  }

  const dedupeCutoff = Date.now() - DEDUPE_TTL_MS;
  for (const [hash, entry] of recentEncrypts.entries()) {
    if (entry.ts < dedupeCutoff) {
      recentEncrypts.delete(hash);
    }
  }

  if (streams.size > STREAM_MAX_ENTRIES) {
    const sorted = Array.from(streams.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const overflow = sorted.length - STREAM_MAX_ENTRIES;
    for (let i = 0; i < overflow; i += 1) {
      const [streamId] = sorted[i]!;
      streams.delete(streamId);
    }
  }

  if (recentEncrypts.size > DEDUPE_MAX_ENTRIES) {
    const sorted = Array.from(recentEncrypts.entries()).sort((a, b) => a[1].ts - b[1].ts);
    const overflow = sorted.length - DEDUPE_MAX_ENTRIES;
    for (let i = 0; i < overflow; i += 1) {
      recentEncrypts.delete(sorted[i]![0]);
    }
  }

  botQueue.prune(STREAM_TTL_MS);
}


function buildEncryptedJsonReply(params: {
  account: ResolvedWecomAccount;
  plaintextJson: unknown;
  nonce: string;
  timestamp: string;
}): { encrypt: string; msg_signature: string; timestamp: string; nonce: string } {
  const plaintext = JSON.stringify(params.plaintextJson ?? {});
  const encrypt = encryptWecomPlaintext({
    encodingAESKey: params.account.encodingAESKey ?? "",
    receiveId: params.account.receiveId ?? "",
    plaintext,
  });
  const msgsignature = computeWecomMsgSignature({
    token: params.account.token ?? "",
    timestamp: params.timestamp,
    nonce: params.nonce,
    encrypt,
  });
  return {
    encrypt,
    msg_signature: msgsignature,
    timestamp: params.timestamp,
    nonce: params.nonce,
  };
}

function buildStreamPlaceholderReply(streamId: string): { msgtype: "stream"; stream: { id: string; finish: boolean; content: string } } {
  return {
    msgtype: "stream",
    stream: {
      id: streamId,
      finish: false,
      content: "\ud83e\udd14\u601d\u8003\u4e2d...",
    },
  };
}

function buildStreamReplyFromState(state: StreamState): { msgtype: "stream"; stream: { id: string; finish: boolean; content: string } } {
  const content = truncateUtf8Bytes(state.content, STREAM_MAX_BYTES);
  return {
    msgtype: "stream",
    stream: {
      id: state.streamId,
      finish: state.finished,
      content,
    },
  };
}

function createStreamId(): string {
  return crypto.randomBytes(16).toString("hex");
}

function hashEncryptPayload(encrypt: string): string {
  return crypto.createHash("sha256").update(encrypt).digest("hex");
}

function logVerbose(target: WecomWebhookTarget, message: string): void {
  try {
    const core = getWecomRuntime();
    const should = core.logging?.shouldLogVerbose?.() ?? false;
    if (should) {
      target.runtime.log?.(`[wecom] ${message}`);
    }
  } catch {
    // runtime not ready; skip verbose logging
  }
}

function parseWecomPlainMessage(raw: string): WecomInboundMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return parsed as WecomInboundMessage;
}

async function waitForStreamContent(streamId: string, maxWaitMs: number): Promise<void> {
  if (maxWaitMs <= 0) return;
  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const state = streams.get(streamId);
      if (!state) return resolve();
      if (state.error || state.finished || state.content.trim()) return resolve();
      if (Date.now() - startedAt >= maxWaitMs) return resolve();
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function startAgentForStream(params: {
  target: WecomWebhookTarget;
  accountId: string;
  msg: WecomInboundMessage;
  streamId: string;
}): Promise<void> {
  const { target, msg, streamId } = params;
  const account = target.account;

  const userid = msg.from?.userid?.trim() || "unknown";
  const chatType = msg.chattype === "group" ? "group" : "direct";
  const chatId = msg.chattype === "group" ? (msg.chatid?.trim() || "unknown") : userid;
  const inbound = await buildInboundBody({ target, msg });
  const rawBody = inbound.text;

  const { core, route, storePath, ctxPayload, tableMode } = buildAgentContext({
    target,
    fromUser: userid,
    chatId: chatType === "group" ? chatId : undefined,
    isGroup: chatType === "group",
    messageText: rawBody,
    messageSid: msg.msgid ? String(msg.msgid) : undefined,
    media: inbound.media,
  });

  logVerbose(target, `starting agent processing (streamId=${streamId}, agentId=${route.agentId}, peerKind=${chatType}, peerId=${chatId})`);

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      target.runtime.error?.(`wecom: failed updating session meta: ${String(err)}`);
    },
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: target.config,
    dispatcherOptions: {
      deliver: async (payload) => {
        const canBridgeMedia = account.config.botMediaBridge !== false
          && Boolean(account.corpId && account.corpSecret && account.agentId);
        const toChatId = chatType === "group" ? chatId : undefined;
        const current = streams.get(streamId);
        if (!current) return;

        // ── 超时降级检测 ──
        const agentConfigured = Boolean(account.corpId && account.corpSecret && account.agentId);
        if (!current.fallbackMode && shouldFallbackToDm(current) && agentConfigured && userid !== "unknown") {
          current.fallbackMode = "timeout";
          const prompt = buildFallbackPrompt({ kind: "timeout", agentConfigured, userId: userid });
          // 把当前已有内容存入 dmContent
          if (current.content.trim()) appendDmContent(current, current.content);
          // 在流中发送降级提示
          current.content = truncateUtf8Bytes(
            current.content ? `${current.content}\n\n${prompt}` : prompt,
            STREAM_MAX_BYTES,
          );
          current.updatedAt = Date.now();
        }

        // 如果已进入降级模式，后续内容走 Agent DM
        if (current.fallbackMode && agentConfigured && userid !== "unknown") {
          const text = payload.text ?? "";
          if (text.trim()) appendDmContent(current, text.trim());
          // 媒体也走 DM
          if (canBridgeMedia) {
            try {
              const result = await dispatchOutboundMedia({
                payload, account, toUser: userid, chatId: toChatId,
                maxBytes: resolveMediaMaxBytes(target),
              });
              if (result.sent) {
                appendDmContent(current, result.label ?? "[已发送媒体]");
                target.statusSink?.({ lastOutboundAt: Date.now() });
              }
            } catch (err) {
              target.runtime.error?.(`[${account.accountId}] wecom bot media bridge failed: ${String(err)}`);
            }
          }
          return;
        }

        // ── 正常流式路径 ──
        if (canBridgeMedia) {
          try {
            const result = await dispatchOutboundMedia({
              payload,
              account,
              toUser: userid,
              chatId: toChatId,
              maxBytes: resolveMediaMaxBytes(target),
            });
            if (result.sent) {
              const current = streams.get(streamId);
              if (current) {
                const note = result.label ?? "[已发送媒体]";
                const nextText = current.content ? `${current.content}\n\n${note}` : note;
                current.content = truncateUtf8Bytes(nextText.trim(), STREAM_MAX_BYTES);
                current.updatedAt = Date.now();
              }
              target.statusSink?.({ lastOutboundAt: Date.now() });
            }
          } catch (err) {
            target.runtime.error?.(`[${account.accountId}] wecom bot media bridge failed: ${String(err)}`);
          }
        }

        let text = payload.text ?? "";
        const current = streams.get(streamId);
        if (!current) return;

        const trimmedText = text.trim();
        if (trimmedText.startsWith("{") && trimmedText.includes("\"template_card\"")) {
          try {
            const parsed = JSON.parse(trimmedText) as { template_card?: Record<string, unknown> };
            if (parsed.template_card) {
              const isSingleChat = chatType !== "group";
              const responseUrl = current.responseUrl;
              if (isSingleChat && responseUrl) {
                try {
                  const res = await fetch(responseUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ msgtype: "template_card", template_card: parsed.template_card }),
                  });
                  if (!res.ok) {
                    throw new Error(`response_url status ${res.status}`);
                  }
                  current.finished = true;
                  current.content = current.content || "[已发送交互卡片]";
                  current.updatedAt = Date.now();
                  target.statusSink?.({ lastOutboundAt: Date.now() });
                  return;
                } catch (err) {
                  target.runtime.error?.(
                    `[${account.accountId}] wecom bot template_card send failed: ${String(err)}`,
                  );
                }
              }
              const cardTitle = (parsed.template_card as any)?.main_title?.title || "交互卡片";
              const cardDesc = (parsed.template_card as any)?.main_title?.desc || "";
              const buttons = Array.isArray((parsed.template_card as any)?.button_list)
                ? (parsed.template_card as any).button_list.map((b: any) => b?.text).filter(Boolean).join(" / ")
                : "";
              text = `【交互卡片】${cardTitle}${cardDesc ? `\n${cardDesc}` : ""}${buttons ? `\n\n选项: ${buttons}` : ""}`;
            }
          } catch {
            // ignore parse failure, treat as normal text
          }
        }

        text = core.channel.text.convertMarkdownTables(text, tableMode);
        const nextText = current.content
          ? `${current.content}\n\n${text}`.trim()
          : text.trim();
        current.content = truncateUtf8Bytes(nextText, STREAM_MAX_BYTES);
        current.updatedAt = Date.now();
        target.statusSink?.({ lastOutboundAt: Date.now() });
      },
      onError: (err, info) => {
        target.runtime.error?.(`[${account.accountId}] wecom ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });

  const current = streams.get(streamId);
  if (current) {
    current.finished = true;
    current.updatedAt = Date.now();

    // 如果有降级内容，通过 Agent DM 发送
    if (current.fallbackMode && current.dmContent?.trim() && userid !== "unknown") {
      const agentConfigured = Boolean(account.corpId && account.corpSecret && account.agentId);
      if (agentConfigured) {
        try {
          await sendAgentDmText({ account, userId: userid, text: current.dmContent.trim() });
          target.statusSink?.({ lastOutboundAt: Date.now() });
        } catch (err) {
          target.runtime.error?.(`[${account.accountId}] wecom bot DM fallback failed: ${String(err)}`);
        }
      }
    }
  }
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
    // 这种情况较少见，保留内联处理
    const parsed = parseBase64Input(base64);
    const buffer = Buffer.from(parsed.data, "base64");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { resolveMediaTempDir, resolveExtFromContentType, sanitizeFilename } = await import("./media-utils.js");
    const { mediaFallbackExt } = await import("./shared/media-shared.js");
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
        const { resolveMediaTempDir, resolveExtFromContentType, cleanupMediaDir } = await import("./media-utils.js");
        const { mediaFallbackExt } = await import("./shared/media-shared.js");
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
        target.runtime.error?.(`[${target.account.accountId}] wecom bot media decrypt failed: ${String(err)}`);
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

async function buildInboundBody(params: { target: WecomWebhookTarget; msg: WecomInboundMessage }): Promise<InboundBody> {
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

function shouldHandleBot(account: ResolvedWecomAccount): boolean {
  return account.mode === "bot" || account.mode === "both";
}

export async function handleWecomBotWebhook(params: {
  req: IncomingMessage;
  res: ServerResponse;
  targets: WecomWebhookTarget[];
  rawBody?: string;
}): Promise<boolean> {
  pruneStreams();

  const { req, res, targets, rawBody } = params;
  const botTargets = targets.filter((candidate) => shouldHandleBot(candidate.account));
  if (botTargets.length === 0) {
    return false;
  }
  const query = resolveQueryParams(req);
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const signature = resolveSignatureParam(query);

  const firstTarget = targets[0]!;
  logVerbose(firstTarget, `incoming ${req.method} request (timestamp=${timestamp}, nonce=${nonce}, signature=${signature})`);

  if (req.method === "GET") {
    const echostr = query.get("echostr") ?? "";
    if (!timestamp || !nonce || !signature || !echostr) {
      targets[0]?.runtime?.log?.(
        `[wecom] bot GET missing params (timestamp=${Boolean(timestamp)} nonce=${Boolean(nonce)} signature=${Boolean(signature)} echostr=${Boolean(echostr)})`,
      );
      return false;
    }

    const target = botTargets.find((candidate) => {
      if (!shouldHandleBot(candidate.account)) return false;
      if (!candidate.account.configured || !candidate.account.token) return false;
      const ok = verifyWecomSignature({
        token: candidate.account.token,
        timestamp,
        nonce,
        encrypt: echostr,
        signature,
      });
      return ok;
    });
    if (!target || !target.account.encodingAESKey) {
      targets[0]?.runtime?.log?.("[wecom] bot GET signature verify failed");
      return false;
    }
    try {
      const plain = decryptBotEncrypted(target.account, echostr);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(plain);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      targets[0]?.runtime?.error?.(`[wecom] bot GET decrypt failed: ${msg}`);
      res.statusCode = 400;
      res.end(msg || "decrypt failed");
      return true;
    }
  }

  if (req.method !== "POST") {
    return false;
  }

  if (!timestamp || !nonce || !signature) {
    return false;
  }

  // Parse body from pre-read rawBody instead of reading stream again
  let record: Record<string, unknown> | null = null;
  if (rawBody != null) {
    const trimmed = rawBody.trim();
    if (!trimmed) {
      return false; // empty body, not a bot request
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return false; // not JSON, let app handler try XML
    }
  } else {
    const body = await readJsonBody(req, 1024 * 1024);
    if (!body.ok) {
      res.statusCode = body.error === "payload too large" ? 413 : 400;
      res.end(body.error ?? "invalid payload");
      return true;
    }
    record = body.value && typeof body.value === "object" ? (body.value as Record<string, unknown>) : null;
  }
  const encrypt = record ? String(record.encrypt ?? record.Encrypt ?? "") : "";
  if (!encrypt) {
    res.statusCode = 400;
    res.end("missing encrypt");
    return true;
  }

    const target = botTargets.find((candidate) => {
      if (!shouldHandleBot(candidate.account)) return false;
      if (!candidate.account.token) return false;
    const ok = verifyWecomSignature({
      token: candidate.account.token,
      timestamp,
      nonce,
      encrypt,
      signature,
    });
    return ok;
  });
  if (!target) {
    return false;
  }

  if (!target.account.configured || !target.account.token || !target.account.encodingAESKey) {
    res.statusCode = 500;
    res.end("wecom not configured");
    return true;
  }

  const encryptHash = hashEncryptPayload(encrypt);
  const dedupeEntry = recentEncrypts.get(encryptHash);
  if (dedupeEntry && Date.now() - dedupeEntry.ts <= DEDUPE_TTL_MS) {
    const streamId = dedupeEntry.streamId ?? "";
    const state = streamId ? streams.get(streamId) : undefined;
    if (streamId && state) {
      const reply = state.error || state.content.trim()
        ? buildStreamReplyFromState(state)
        : buildStreamPlaceholderReply(streamId);
      logVerbose(target, `bot dedupe hit streamId=${streamId}`);
      jsonOk(res, buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: reply,
        nonce,
        timestamp,
      }));
      dedupeEntry.ts = Date.now();
      return true;
    }
    recentEncrypts.delete(encryptHash);
  }

  let plain: string;
  try {
    plain = decryptBotEncrypted(target.account, encrypt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.statusCode = 400;
    res.end(msg || "decrypt failed");
    return true;
  }

  const msg = parseWecomPlainMessage(plain);
  target.statusSink?.({ lastInboundAt: Date.now() });

  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  const msgid = msg.msgid ? String(msg.msgid) : undefined;
  logVerbose(target, `bot inbound msgtype=${msgtype || "unknown"} msgid=${msgid || "n/a"}`);

  if (msgtype === "stream") {
    const streamId = String((msg as any).stream?.id ?? "").trim();
    const state = streamId ? streams.get(streamId) : undefined;
    const reply = state
      ? buildStreamReplyFromState(state)
      : buildStreamReplyFromState({
          streamId: streamId || "unknown",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          started: true,
          finished: true,
          content: "",
        });
    logVerbose(target, `bot stream refresh reply streamId=${streamId || "unknown"} finished=${Boolean(state?.finished)}`);
    jsonOk(res, buildEncryptedJsonReply({
      account: target.account,
      plaintextJson: reply,
      nonce,
      timestamp,
    }));
    return true;
  }

  if (msgtype !== "event" && msgid && msgidToStreamId.has(msgid)) {
    const streamId = msgidToStreamId.get(msgid) ?? "";
    const reply = buildStreamPlaceholderReply(streamId);
    logVerbose(target, `bot stream placeholder reply streamId=${streamId || "unknown"}`);
    jsonOk(res, buildEncryptedJsonReply({
      account: target.account,
      plaintextJson: reply,
      nonce,
      timestamp,
    }));
    return true;
  }

  if (msgtype === "event") {
    const eventtype = String((msg as any).event?.eventtype ?? "").toLowerCase();
    if (eventtype === "template_card_event") {
      if (msgid && msgidToStreamId.has(msgid)) {
        jsonOk(res, buildEncryptedJsonReply({
          account: target.account,
          plaintextJson: {},
          nonce,
          timestamp,
        }));
        return true;
      }

      const cardEvent = (msg as any).event?.template_card_event;
      let interactionDesc = `[卡片交互] 按钮: ${cardEvent?.event_key || "unknown"}`;
      const selected = cardEvent?.selected_items?.selected_item;
      if (Array.isArray(selected) && selected.length > 0) {
        const selects = selected.map((item: any) => {
          const key = item?.question_key || "unknown";
          const options = Array.isArray(item?.option_ids?.option_id)
            ? item.option_ids.option_id.join(",")
            : "";
          return `${key}=${options}`;
        }).join("; ");
        if (selects) interactionDesc += ` 选择: ${selects}`;
      }
      if (cardEvent?.task_id) interactionDesc += ` (任务ID: ${cardEvent.task_id})`;

      jsonOk(res, buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: {},
        nonce,
        timestamp,
      }));

      const streamId = createStreamId();
      if (msgid) msgidToStreamId.set(msgid, streamId);
      streams.set(streamId, {
        streamId,
        msgid,
        responseUrl: typeof (msg as any).response_url === "string" ? String((msg as any).response_url).trim() : undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        started: true,
        finished: false,
        content: "",
      });
      recentEncrypts.set(encryptHash, { ts: Date.now(), streamId });

      let core: PluginRuntime | null = null;
      try {
        core = getWecomRuntime();
      } catch (err) {
        logVerbose(target, `runtime not ready, skipping agent processing: ${String(err)}`);
      }
      if (core) {
        const enrichedTarget: WecomWebhookTarget = { ...target, core };
        const eventMsg = {
          ...msg,
          msgtype: "text",
          text: { content: interactionDesc },
        } as WecomInboundMessage;
        startAgentForStream({ target: enrichedTarget, accountId: target.account.accountId, msg: eventMsg, streamId })
          .catch((err) => {
            const state = streams.get(streamId);
            if (state) {
              state.error = err instanceof Error ? err.message : String(err);
              state.content = state.content || `Error: ${state.error}`;
              state.finished = true;
              state.updatedAt = Date.now();
            }
            target.runtime.error?.(`[${target.account.accountId}] wecom agent failed: ${String(err)}`);
          });
      } else {
        const state = streams.get(streamId);
        if (state) {
          state.finished = true;
          state.updatedAt = Date.now();
        }
      }

      return true;
    }
    if (eventtype === "enter_chat") {
      const welcome = target.account.config.welcomeText?.trim();
      const reply = welcome
        ? { msgtype: "text", text: { content: welcome } }
        : {};
      logVerbose(target, "bot event enter_chat reply");
      jsonOk(res, buildEncryptedJsonReply({
        account: target.account,
        plaintextJson: reply,
        nonce,
        timestamp,
      }));
      return true;
    }

    logVerbose(target, "bot event reply empty");
    jsonOk(res, buildEncryptedJsonReply({
      account: target.account,
      plaintextJson: {},
      nonce,
      timestamp,
    }));
    return true;
  }

  const streamId = createStreamId();
  if (msgid) msgidToStreamId.set(msgid, streamId);

  const userid = msg.from?.userid?.trim() || "unknown";
  const chatType = msg.chattype === "group" ? "group" : "direct";
  const convChatId = msg.chattype === "group" ? (msg.chatid?.trim() || "unknown") : userid;
  const conversationKey = `${target.account.accountId}:${convChatId}`;

  streams.set(streamId, {
    streamId,
    msgid,
    responseUrl: typeof (msg as any).response_url === "string" ? String((msg as any).response_url).trim() : undefined,
    conversationKey,
    userId: userid,
    chatType,
    chatId: convChatId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    started: false,
    finished: false,
    content: "",
  });
  recentEncrypts.set(encryptHash, { ts: Date.now(), streamId });

  // 解析消息文本用于防抖聚合
  const inboundText = msgtype === "text"
    ? String((msg as any).text?.content ?? "")
    : `[${msgtype}]`;

  const debounceMs = typeof target.account.config.debounceMs === "number"
    ? target.account.config.debounceMs : DEFAULT_DEBOUNCE_MS;

  // 将消息加入防抖队列
  const { status } = botQueue.add({
    conversationKey,
    content: inboundText,
    meta: { target, msg, streamId, nonce, timestamp },
  });

  logVerbose(target, `bot queue status=${status} conversationKey=${conversationKey}`);

  // 非文本消息或首条消息直接处理（不防抖）
  if (msgtype !== "text" || status === "active_new") {
    // active_new 的消息会在防抖超时后自动 flush
    // 非文本消息需要立即处理（媒体不适合聚合）
    if (msgtype !== "text") {
      let core: PluginRuntime | null = null;
      try { core = getWecomRuntime(); } catch { /* runtime not ready */ }
      if (core) {
        streams.get(streamId)!.started = true;
        const enrichedTarget: WecomWebhookTarget = { ...target, core };
        startAgentForStream({ target: enrichedTarget, accountId: target.account.accountId, msg, streamId }).catch((err) => {
          const state = streams.get(streamId);
          if (state) {
            state.error = err instanceof Error ? err.message : String(err);
            state.content = state.content || `Error: ${state.error}`;
            state.finished = true;
            state.updatedAt = Date.now();
          }
          target.runtime.error?.(`[${target.account.accountId}] wecom agent failed: ${String(err)}`);
        });
      } else {
        const state = streams.get(streamId);
        if (state) { state.finished = true; state.updatedAt = Date.now(); }
      }
    }
  }

  await waitForStreamContent(streamId, 800);
  const state = streams.get(streamId);
  const initialReply = state && (state.content.trim() || state.error)
    ? buildStreamReplyFromState(state)
    : buildStreamPlaceholderReply(streamId);

  logVerbose(
    target,
    `bot initial reply streamId=${streamId} mode=${state && (state.content.trim() || state.error) ? "stream" : "placeholder"}`,
  );
  target.runtime.log?.(`[wecom] bot reply acked streamId=${streamId} msgid=${msgid || "n/a"}`);
  jsonOk(res, buildEncryptedJsonReply({
    account: target.account,
    plaintextJson: initialReply,
    nonce,
    timestamp,
  }));

  return true;
}

function decryptBotEncrypted(account: ResolvedWecomAccount, encrypt: string): string {
  const encodingAESKey = account.encodingAESKey ?? "";
  if (!encodingAESKey) {
    throw new Error("encodingAESKey missing");
  }
  const receiveId = account.receiveId || "";
  try {
    return decryptWecomEncrypted({ encodingAESKey, receiveId, encrypt });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("receiveId mismatch")) {
      throw err;
    }
    // Some WeCom bot callbacks omit receiveId in the encrypted payload.
    return decryptWecomEncrypted({ encodingAESKey, encrypt });
  }
}
