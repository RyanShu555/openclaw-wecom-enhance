import type { ServerResponse } from "node:http";

function writeJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function replyPushMethodNotAllowed(res: ServerResponse): void {
  res.statusCode = 405;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Method Not Allowed");
}

export function replyPushInvalidJson(res: ServerResponse, message: string): void {
  writeJson(res, 400, { ok: false, error: `Invalid JSON: ${message}` });
}

export function replyPushPayloadTooLarge(res: ServerResponse): void {
  writeJson(res, 413, { ok: false, error: "Payload too large" });
}

export function replyPushNoMatchingAccount(res: ServerResponse): void {
  writeJson(res, 404, { ok: false, error: "No matching WeCom app account" });
}

export function replyPushTokenNotConfigured(res: ServerResponse): void {
  writeJson(res, 403, { ok: false, error: "Push token not configured" });
}

export function replyPushTokenInvalid(res: ServerResponse): void {
  writeJson(res, 403, { ok: false, error: "Invalid push token" });
}

export function replyPushMissingRecipient(res: ServerResponse): void {
  writeJson(res, 400, { ok: false, error: "Missing toUser or chatId" });
}

export function replyPushAppNotConfigured(res: ServerResponse): void {
  writeJson(res, 500, { ok: false, error: "WeCom app not configured" });
}

export function replyPushSuccess(res: ServerResponse, sent: number): void {
  writeJson(res, 200, { ok: true, sent });
}
