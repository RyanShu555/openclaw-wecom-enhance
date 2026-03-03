import type { WecomInboundMessage } from "../types.js";

export function parseBotPlainMessage(raw: string): WecomInboundMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }
  return parsed as WecomInboundMessage;
}

export function resolveBotMessageMeta(msg: WecomInboundMessage): {
  msgtype: string;
  msgid?: string;
} {
  return {
    msgtype: String(msg.msgtype ?? "").toLowerCase(),
    msgid: msg.msgid ? String(msg.msgid) : undefined,
  };
}
