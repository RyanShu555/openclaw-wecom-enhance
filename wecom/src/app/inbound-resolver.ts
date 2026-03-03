import type { WecomWebhookTarget } from "../monitor.js";
import {
  getCachedMedia,
  MEDIA_CACHE_MAX_ENTRIES,
  type MediaCacheEntry,
  storeCachedMedia,
} from "../shared/cache-utils.js";
import { processInboundMedia } from "../shared/media-inbound.js";
import type { AppMediaContext } from "./reply-delivery.js";

const mediaCache = new Map<string, MediaCacheEntry>();

async function getLocalCachedMedia(
  key: string | null,
  retentionMs?: number,
): Promise<MediaCacheEntry | null> {
  return getCachedMedia(mediaCache, key, retentionMs);
}

function storeLocalCachedMedia(key: string | null, entry: MediaCacheEntry): void {
  storeCachedMedia(mediaCache, key, entry, MEDIA_CACHE_MAX_ENTRIES);
}

export type ResolvedAppInboundMessage = {
  msgType: string;
  fromUser: string;
  chatId: string;
  isGroup: boolean;
  summary: string;
  messageText: string;
  mediaContext: AppMediaContext;
};

export async function resolveAppInboundMessage(params: {
  target: WecomWebhookTarget;
  msgObj: Record<string, any>;
}): Promise<ResolvedAppInboundMessage> {
  const { target, msgObj } = params;
  const msgType = String(msgObj?.MsgType ?? "").toLowerCase();
  const fromUser = String(msgObj?.FromUserName ?? "");
  const chatId = msgObj?.ChatId ? String(msgObj.ChatId) : "";
  const isGroup = Boolean(chatId);
  const summary = msgObj?.Content ? String(msgObj.Content).slice(0, 120) : "";

  let messageText = "";
  let mediaContext: AppMediaContext = null;

  if (msgType === "text") {
    messageText = String(msgObj?.Content ?? "");
  }

  if (msgType === "voice") {
    const recognition = String(msgObj?.Recognition ?? "").trim();
    if (recognition) {
      messageText = `[语音消息转写] ${recognition}`;
    } else {
      const mediaId = String(msgObj?.MediaId ?? "");
      if (mediaId) {
        const result = await processInboundMedia({
          target, msgtype: "voice", mediaId,
          getCache: getLocalCachedMedia, storeCache: storeLocalCachedMedia,
        });
        messageText = result.text;
        if (result.media) mediaContext = { type: "voice", path: result.media.path, mimeType: result.media.mimeType, url: result.media.url };
      } else {
        messageText = "[用户发送了一条语音消息]\n\n请告诉用户语音处理暂时不可用。";
      }
    }
  }

  if (msgType === "image") {
    const mediaId = String(msgObj?.MediaId ?? "");
    const picUrl = String(msgObj?.PicUrl ?? "");
    const result = await processInboundMedia({
      target, msgtype: "image", mediaId: mediaId || undefined, url: picUrl || undefined,
      getCache: getLocalCachedMedia, storeCache: storeLocalCachedMedia,
    });
    messageText = result.text;
    if (result.media) mediaContext = { type: "image", path: result.media.path, mimeType: result.media.mimeType, url: result.media.url };
  }

  if (msgType === "link") {
    const title = String(msgObj?.Title ?? "(无标题)");
    const desc = String(msgObj?.Description ?? "(无描述)");
    const url = String(msgObj?.Url ?? "(无链接)");
    messageText = `[用户分享了一个链接]\n标题: ${title}\n描述: ${desc}\n链接: ${url}\n\n请根据链接内容回复用户。`;
  }

  if (msgType === "video") {
    const mediaId = String(msgObj?.MediaId ?? "");
    if (mediaId) {
      const result = await processInboundMedia({
        target, msgtype: "video", mediaId,
        getCache: getLocalCachedMedia, storeCache: storeLocalCachedMedia,
      });
      messageText = result.text;
      if (result.media) mediaContext = { type: "video", path: result.media.path, mimeType: result.media.mimeType, url: result.media.url };
    }
  }

  if (msgType === "file") {
    const mediaId = String(msgObj?.MediaId ?? "");
    const fileName = String(msgObj?.FileName ?? "");
    if (mediaId) {
      const result = await processInboundMedia({
        target, msgtype: "file", mediaId, filename: fileName || undefined,
        getCache: getLocalCachedMedia, storeCache: storeLocalCachedMedia,
      });
      messageText = result.text;
      if (result.media) mediaContext = { type: "file", path: result.media.path, mimeType: result.media.mimeType, url: result.media.url };
    }
  }

  return {
    msgType,
    fromUser,
    chatId,
    isGroup,
    summary,
    messageText,
    mediaContext,
  };
}
