import type { IncomingMessage } from "node:http";

import { readRequestBody, resolveHeaderToken } from "../shared/http-utils.js";
import { pickString } from "../shared/string-utils.js";
import type { PushPayload } from "./push-types.js";

const MAX_REQUEST_BODY_SIZE = 1024 * 1024;

export class PushPayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushPayloadTooLargeError";
  }
}

export async function resolvePushPayload(req: IncomingMessage): Promise<PushPayload> {
  let raw = "";
  try {
    raw = await readRequestBody(req, MAX_REQUEST_BODY_SIZE);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/too large/i.test(msg)) {
      throw new PushPayloadTooLargeError(msg);
    }
    throw err;
  }
  return raw ? (JSON.parse(raw) as PushPayload) : {};
}

export type PushRequestParams = {
  accountId: string;
  toUser: string;
  chatId: string;
  requestToken: string;
};

export function resolvePushRequestParams(req: IncomingMessage, payload: PushPayload): PushRequestParams {
  const url = new URL(req.url ?? "/", "http://localhost");
  return {
    accountId: pickString(payload?.accountId, url.searchParams.get("accountId")),
    toUser: pickString(payload?.toUser, url.searchParams.get("toUser")),
    chatId: pickString(payload?.chatId, url.searchParams.get("chatId")),
    requestToken: pickString(
      payload?.token,
      url.searchParams.get("token"),
      resolveHeaderToken(req),
    ),
  };
}
