import type { WecomWebhookTarget } from "../monitor.js";
import type { WecomInboundMessage } from "../types.js";
import { jsonOk } from "../shared/http-utils.js";
import { replyBotEmptyEvent, replyBotEnterChatEvent } from "./event-reply.js";
import { handleTemplateCardEvent } from "./template-card-event-handler.js";
import type { LogVerboseFn, StartAgentForStreamFn } from "./contracts.js";

export function handleBotEventMessage(params: {
  target: WecomWebhookTarget;
  res: Parameters<typeof jsonOk>[0];
  msg: WecomInboundMessage;
  msgid?: string;
  nonce: string;
  timestamp: string;
  encryptHash: string;
  startAgentForStream: StartAgentForStreamFn;
  logVerbose: LogVerboseFn;
}): boolean {
  const {
    target,
    res,
    msg,
    msgid,
    nonce,
    timestamp,
    encryptHash,
    startAgentForStream,
    logVerbose,
  } = params;

  const eventtype = String((msg as any).event?.eventtype ?? "").toLowerCase();
  if (eventtype === "template_card_event") {
    return handleTemplateCardEvent({
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

  if (eventtype === "enter_chat") {
    return replyBotEnterChatEvent({
      target,
      res,
      nonce,
      timestamp,
      logVerbose,
    });
  }

  return replyBotEmptyEvent({
    target,
    res,
    nonce,
    timestamp,
    logVerbose,
  });
}
