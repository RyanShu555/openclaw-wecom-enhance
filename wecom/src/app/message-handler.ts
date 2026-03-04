import type { WecomWebhookTarget } from "../monitor.js";

import { sendWecomText } from "../wecom-api.js";
import { formatErrorDetail } from "../shared/string-utils.js";
import { startAgentForApp } from "./reply-delivery.js";
import { resolveAppInboundMessage } from "./inbound-resolver.js";

function logVerbose(target: WecomWebhookTarget, message: string): void {
  target.runtime.log?.(`[wecom] ${message}`);
}

export async function processAppMessage(params: {
  target: WecomWebhookTarget;
  decryptedXml: string;
  msgObj: Record<string, any>;
}): Promise<void> {
  const { target, msgObj } = params;
  const inbound = await resolveAppInboundMessage({ target, msgObj });
  const {
    msgType,
    fromUser,
    chatId,
    isGroup,
    summary,
    messageText,
    mediaContext,
  } = inbound;
  logVerbose(target, `app inbound: MsgType=${msgType} From=${fromUser} ChatId=${chatId || "N/A"} Content=${summary}`);

  if (!fromUser) return;

  if (!messageText && !mediaContext) {
    return;
  }

  try {
    await startAgentForApp({
      target,
      fromUser,
      chatId,
      isGroup,
      messageText,
      media: mediaContext,
    });
  } catch (err) {
    target.runtime.error?.(`wecom app agent failed: ${formatErrorDetail(err)}`);
    try {
      await sendWecomText({
        account: target.account,
        toUser: fromUser,
        chatId: isGroup ? chatId : undefined,
        text: "抱歉，处理您的消息时出现错误，请稍后重试。",
      });
    } catch {
      // ignore
    }
  }
}
