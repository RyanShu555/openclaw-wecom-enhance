import type { ServerResponse } from "node:http";

export function replyBotPayloadTooLarge(res: ServerResponse): void {
  res.statusCode = 413;
  res.end("payload too large");
}

export function replyBotMissingEncrypt(res: ServerResponse): void {
  res.statusCode = 400;
  res.end("missing encrypt");
}

export function replyBotNotConfigured(res: ServerResponse): void {
  res.statusCode = 500;
  res.end("wecom not configured");
}
