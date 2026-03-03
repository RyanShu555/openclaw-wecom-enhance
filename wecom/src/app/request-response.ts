import type { ServerResponse } from "node:http";

export function replyAppPayloadTooLarge(res: ServerResponse): void {
  res.statusCode = 413;
  res.end("payload too large");
}

export function replyAppMissingEncrypt(res: ServerResponse): void {
  res.statusCode = 400;
  res.end("Missing Encrypt");
}

export function replyAppNotConfigured(res: ServerResponse): void {
  res.statusCode = 500;
  res.end("wecom app not configured");
}

export function replyAppSuccessAck(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("success");
}
