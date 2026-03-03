import type { IncomingMessage, ServerResponse } from "node:http";

import type { WecomWebhookTarget } from "./monitor.js";
import { processAppMessage } from "./app/message-handler.js";
import { handleWecomAppWebhookCore } from "./app/webhook-handler.js";

export { handleWecomPushRequest } from "./app/push-handler.js";

export async function handleWecomAppWebhook(params: {
  req: IncomingMessage;
  res: ServerResponse;
  targets: WecomWebhookTarget[];
  rawBody?: string;
}): Promise<boolean> {
  return handleWecomAppWebhookCore({
    ...params,
    processAppMessage,
  });
}
