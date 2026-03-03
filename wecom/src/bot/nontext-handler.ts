import type { WecomWebhookTarget } from "../monitor.js";
import type { WecomInboundMessage } from "../types.js";
import type { StartAgentForStreamFn } from "./contracts.js";
import { startBotStreamAgentOrFinish } from "./stream-runner.js";

export function handleBotNonTextInbound(params: {
  target: WecomWebhookTarget;
  msg: WecomInboundMessage;
  streamId: string;
  startAgentForStream: StartAgentForStreamFn;
}): void {
  startBotStreamAgentOrFinish(params);
}
