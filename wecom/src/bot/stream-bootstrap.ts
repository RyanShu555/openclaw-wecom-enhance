import type { WecomWebhookTarget } from "../monitor.js";
import type { WecomInboundMessage } from "../types.js";
import {
  createStreamId,
  msgidToStreamId,
  recentEncrypts,
  streams,
} from "./state.js";

export function initBotStreamForInboundMessage(params: {
  target: WecomWebhookTarget;
  msg: WecomInboundMessage;
  msgtype: string;
  msgid?: string;
  encryptHash: string;
}): {
  streamId: string;
  conversationKey: string;
  inboundText: string;
} {
  const { target, msg, msgtype, msgid, encryptHash } = params;

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

  const inboundText = msgtype === "text"
    ? String((msg as any).text?.content ?? "")
    : `[${msgtype}]`;

  return {
    streamId,
    conversationKey,
    inboundText,
  };
}
