import type { WecomWebhookTarget } from "../monitor.js";
import type { WecomInboundMessage } from "../types.js";

export type BotBatchMeta = {
  target: WecomWebhookTarget;
  msg: WecomInboundMessage;
  streamId: string;
  nonce: string;
  timestamp: string;
};

export type BotQueueLike = {
  add: (params: {
    conversationKey: string;
    content: string;
    meta: BotBatchMeta;
  }) => { status: string };
};

export type StartAgentForStreamFn = (params: {
  target: WecomWebhookTarget;
  msg: WecomInboundMessage;
  streamId: string;
}) => Promise<void>;

export type LogVerboseFn = (target: WecomWebhookTarget, message: string) => void;
