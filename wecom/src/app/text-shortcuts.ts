import type { WecomWebhookTarget } from "../monitor.js";
import { handleCommand } from "../commands.js";
import { tryHandleNaturalFileSend } from "./file-send.js";

function isTextCommand(text: string): boolean {
  return text.trim().startsWith("/");
}

export async function tryHandleAppTextShortcuts(params: {
  target: WecomWebhookTarget;
  text: string;
  fromUser: string;
  chatId: string;
  isGroup: boolean;
}): Promise<boolean> {
  const { target, text, fromUser, chatId, isGroup } = params;

  if (isTextCommand(text)) {
    const handled = await handleCommand(text, {
      account: target.account,
      fromUser,
      chatId,
      isGroup,
      cfg: target.config,
      log: target.runtime.log,
      statusSink: target.statusSink,
    });
    if (handled) return true;
  }

  return tryHandleNaturalFileSend({
    target,
    text,
    fromUser,
    chatId,
    isGroup,
  });
}
