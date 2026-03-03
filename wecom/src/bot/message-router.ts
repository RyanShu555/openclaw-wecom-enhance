import { jsonOk } from "../shared/http-utils.js";
import type { WecomWebhookTarget } from "../monitor.js";
import type { WecomInboundMessage } from "../types.js";
import { handleBotEventMessage } from "./event-handler.js";
import { initBotStreamForInboundMessage } from "./stream-bootstrap.js";
import { handleBotNonTextInbound } from "./nontext-handler.js";
import {
  replyBotInitialAck,
  tryReplyBotExistingMsgidPlaceholder,
  tryReplyBotStreamRefresh,
} from "./initial-reply.js";
import type {
  BotQueueLike,
  LogVerboseFn,
  StartAgentForStreamFn,
} from "./contracts.js";

export async function routeBotPlainMessage(params: {
  target: WecomWebhookTarget;
  res: Parameters<typeof jsonOk>[0];
  msg: WecomInboundMessage;
  msgtype: string;
  msgid?: string;
  nonce: string;
  timestamp: string;
  encryptHash: string;
  botQueue: BotQueueLike;
  startAgentForStream: StartAgentForStreamFn;
  logVerbose: LogVerboseFn;
}): Promise<boolean> {
  const {
    target,
    res,
    msg,
    msgtype,
    msgid,
    nonce,
    timestamp,
    encryptHash,
    botQueue,
    startAgentForStream,
    logVerbose,
  } = params;

  if (msgtype === "stream") {
    const streamId = String((msg as any).stream?.id ?? "").trim();
    if (tryReplyBotStreamRefresh({
      target,
      res,
      streamId,
      nonce,
      timestamp,
      logVerbose,
    })) {
      return true;
    }
  }

  if (tryReplyBotExistingMsgidPlaceholder({
    target,
    res,
    msgtype,
    msgid,
    nonce,
    timestamp,
    logVerbose,
  })) {
    return true;
  }

  if (msgtype === "event") {
    return handleBotEventMessage({
      target,
      res,
      msg,
      msgid,
      nonce,
      timestamp,
      encryptHash,
      startAgentForStream,
      logVerbose,
    });
  }

  const {
    streamId,
    conversationKey,
    inboundText,
  } = initBotStreamForInboundMessage({
    target,
    msg,
    msgtype,
    msgid,
    encryptHash,
  });

  // 非文本消息（媒体）不适合聚合，跳过队列直接处理
  if (msgtype !== "text") {
    handleBotNonTextInbound({
      target,
      msg,
      streamId,
      startAgentForStream,
    });
  } else {
    // 文本消息加入防抖队列
    const { status } = botQueue.add({
      conversationKey,
      content: inboundText,
      meta: { target, msg, streamId, nonce, timestamp },
    });
    logVerbose(target, `bot queue status=${status} conversationKey=${conversationKey}`);
  }

  await replyBotInitialAck({
    target,
    res,
    streamId,
    msgid,
    nonce,
    timestamp,
    logVerbose,
  });

  return true;
}
