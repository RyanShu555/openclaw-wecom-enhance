import { markdownToWecomText } from "../format.js";
import { sendWecomText } from "../wecom-api.js";
import { resolveMediaMaxBytes } from "../media-utils.js";
import { sleep, formatErrorDetail } from "../shared/string-utils.js";
import { appendOperationLog } from "../shared/log-utils.js";
import { dispatchOutboundMedia } from "../shared/dispatch-media.js";
import type { WecomWebhookTarget } from "../monitor.js";
import type { PushMessage, PushPayload } from "./push-types.js";

const MAX_DELAY_MS = 60_000;

function resolvePushMessages(payload: PushPayload): {
  messages: PushMessage[];
  intervalMs: number;
} {
  const messages = Array.isArray(payload?.messages) && payload.messages.length > 0
    ? payload.messages
    : [payload ?? {}];
  const intervalMs = typeof payload?.intervalMs === "number" && payload.intervalMs > 0
    ? Math.min(payload.intervalMs, MAX_DELAY_MS) : 0;
  return { messages, intervalMs };
}

export async function dispatchPushMessages(params: {
  target: WecomWebhookTarget;
  payload: PushPayload;
  toUser: string;
  chatId: string;
}): Promise<number> {
  const { target, payload, toUser, chatId } = params;
  const { messages, intervalMs } = resolvePushMessages(payload);
  let sent = 0;

  for (const message of messages) {
    if (message.delayMs && message.delayMs > 0) {
      await sleep(Math.min(message.delayMs, MAX_DELAY_MS));
    }
    try {
      const result = await dispatchOutboundMedia({
        payload: message,
        account: target.account,
        toUser,
        chatId: chatId || undefined,
        maxBytes: resolveMediaMaxBytes(target),
        title: message.title,
        description: message.description,
      });
      if (result.sent) {
        await appendOperationLog(target.account.config.operations?.logPath, {
          action: "push-media",
          accountId: target.account.accountId,
          toUser,
          chatId: chatId || undefined,
          mediaType: result.type,
        });
        sent += 1;
      }

      const text = markdownToWecomText(message.text ?? "");
      if (text) {
        await sendWecomText({ account: target.account, toUser, chatId: chatId || undefined, text });
        await appendOperationLog(target.account.config.operations?.logPath, {
          action: "push-text",
          accountId: target.account.accountId,
          toUser,
          chatId: chatId || undefined,
          textPreview: text.slice(0, 120),
        });
        sent += 1;
      }
    } catch (err) {
      target.runtime.error?.(`wecom push failed: ${formatErrorDetail(err)}`);
    }

    if (intervalMs) {
      await sleep(intervalMs);
    }
  }

  return sent;
}
