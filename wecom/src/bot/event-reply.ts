import { jsonOk } from "../shared/http-utils.js";
import { buildEncryptedJsonReply } from "../shared/webhook-crypto.js";
import type { WecomWebhookTarget } from "../monitor.js";
import type { LogVerboseFn } from "./contracts.js";

export function replyBotEmptyEvent(params: {
  target: WecomWebhookTarget;
  res: Parameters<typeof jsonOk>[0];
  nonce: string;
  timestamp: string;
  logVerbose: LogVerboseFn;
}): boolean {
  const { target, res, nonce, timestamp, logVerbose } = params;
  logVerbose(target, "bot event reply empty");
  jsonOk(res, buildEncryptedJsonReply({
    account: target.account,
    plaintextJson: {},
    nonce,
    timestamp,
  }));
  return true;
}

export function replyBotEnterChatEvent(params: {
  target: WecomWebhookTarget;
  res: Parameters<typeof jsonOk>[0];
  nonce: string;
  timestamp: string;
  logVerbose: LogVerboseFn;
}): boolean {
  const { target, res, nonce, timestamp, logVerbose } = params;
  const welcome = target.account.config.welcomeText?.trim();
  const reply = welcome
    ? { msgtype: "text", text: { content: welcome } }
    : {};
  logVerbose(target, "bot event enter_chat reply");
  jsonOk(res, buildEncryptedJsonReply({
    account: target.account,
    plaintextJson: reply,
    nonce,
    timestamp,
  }));
  return true;
}
