import type { IncomingMessage, ServerResponse } from "node:http";

import { readRequestBody } from "../shared/http-utils.js";
import { replyBotPayloadTooLarge } from "./request-response.js";

const MAX_BOT_REQUEST_BODY_SIZE = 1024 * 1024;

type ResolvedBotRequestRecord =
  | { kind: "skip" }
  | { kind: "handled" }
  | { kind: "ok"; record: Record<string, unknown> | null };

function parseBotJsonRecord(raw: string): Record<string, unknown> | null | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return undefined;
  }
}

export async function resolveBotRequestRecord(params: {
  req: IncomingMessage;
  res: ServerResponse;
  rawBody?: string;
}): Promise<ResolvedBotRequestRecord> {
  const { req, res, rawBody } = params;

  if (rawBody != null) {
    const parsed = parseBotJsonRecord(rawBody);
    if (parsed === undefined) return { kind: "skip" };
    return { kind: "ok", record: parsed };
  }

  let raw: string;
  try {
    raw = await readRequestBody(req, MAX_BOT_REQUEST_BODY_SIZE);
  } catch {
    replyBotPayloadTooLarge(res);
    return { kind: "handled" };
  }

  const parsed = parseBotJsonRecord(raw);
  if (parsed === undefined) return { kind: "skip" };
  return { kind: "ok", record: parsed };
}

export function resolveBotEncryptFromRecord(record: Record<string, unknown> | null): string {
  return record ? String(record.encrypt ?? record.Encrypt ?? "") : "";
}
