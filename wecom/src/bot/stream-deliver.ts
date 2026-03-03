import type { WecomWebhookTarget } from "../monitor.js";
import { resolveMediaMaxBytes } from "../media-utils.js";
import { dispatchOutboundMedia } from "../shared/dispatch-media.js";
import { formatErrorDetail } from "../shared/string-utils.js";
import { streams } from "./state.js";
import { appendStreamMediaNote, appendStreamText } from "./stream-content.js";
import {
  appendDmContent,
  tryEnterTimeoutFallback,
} from "./stream-fallback.js";
import { tryHandleTemplateCardText } from "./stream-template-card.js";

export async function deliverStreamPayload(params: {
  target: WecomWebhookTarget;
  streamId: string;
  userId: string;
  chatType: "group" | "direct";
  chatId: string;
  tableMode: boolean;
  payload: { text?: string; [k: string]: any };
  convertMarkdownTables: (text: string, tableMode: boolean) => string;
}): Promise<void> {
  const {
    target,
    streamId,
    userId,
    chatType,
    chatId,
    tableMode,
    payload,
    convertMarkdownTables,
  } = params;

  const account = target.account;
  const agentConfigured = Boolean(account.corpId && account.corpSecret && account.agentId);
  const canBridgeMedia = account.config.botMediaBridge !== false && agentConfigured;
  const toChatId = chatType === "group" ? chatId : undefined;

  let current = streams.get(streamId);
  if (!current) return;

  tryEnterTimeoutFallback({ state: current, userId, agentConfigured });

  if (current.fallbackMode && agentConfigured && userId !== "unknown") {
    const text = payload.text ?? "";
    if (text.trim()) appendDmContent(current, text.trim());
    if (canBridgeMedia) {
      try {
        const result = await dispatchOutboundMedia({
          payload,
          account,
          toUser: userId,
          chatId: toChatId,
          maxBytes: resolveMediaMaxBytes(target),
        });
        if (result.sent) {
          appendDmContent(current, result.label ?? "[已发送媒体]");
          target.statusSink?.({ lastOutboundAt: Date.now() });
        }
      } catch (err) {
        target.runtime.error?.(`[${account.accountId}] wecom bot media bridge failed: ${formatErrorDetail(err)}`);
      }
    }
    return;
  }

  if (canBridgeMedia) {
    try {
      const result = await dispatchOutboundMedia({
        payload,
        account,
        toUser: userId,
        chatId: toChatId,
        maxBytes: resolveMediaMaxBytes(target),
      });
      if (result.sent) {
        current = streams.get(streamId);
        if (current) {
          appendStreamMediaNote(current, result.label ?? "[已发送媒体]");
        }
        target.statusSink?.({ lastOutboundAt: Date.now() });
      }
    } catch (err) {
      target.runtime.error?.(`[${account.accountId}] wecom bot media bridge failed: ${formatErrorDetail(err)}`);
    }
  }

  let text = payload.text ?? "";
  current = streams.get(streamId);
  if (!current) return;

  const templateCardResult = await tryHandleTemplateCardText({
    target,
    accountId: account.accountId,
    chatType,
    state: current,
    text,
  });
  if (templateCardResult.consumed) {
    return;
  }
  text = templateCardResult.text;

  text = convertMarkdownTables(text, tableMode);
  appendStreamText(current, text);
  target.statusSink?.({ lastOutboundAt: Date.now() });
}
