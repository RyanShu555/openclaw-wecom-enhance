import type { IncomingMessage, ServerResponse } from "node:http";

import { readRequestBody } from "../shared/http-utils.js";
import { replyAppPayloadTooLarge } from "./request-response.js";

const MAX_APP_REQUEST_BODY_SIZE = 1024 * 1024;

type ResolvedAppRequestXml =
  | { kind: "skip" }
  | { kind: "handled" }
  | { kind: "ok"; rawXml: string };

export async function resolveAppRequestXml(params: {
  req: IncomingMessage;
  res: ServerResponse;
  rawBody?: string;
}): Promise<ResolvedAppRequestXml> {
  const { req, res, rawBody } = params;

  let rawXml = "";
  if (rawBody != null) {
    rawXml = rawBody;
  } else {
    try {
      rawXml = await readRequestBody(req, MAX_APP_REQUEST_BODY_SIZE);
    } catch {
      replyAppPayloadTooLarge(res);
      return { kind: "handled" };
    }
  }

  if (!rawXml.trim().startsWith("<")) {
    return { kind: "skip" };
  }

  return { kind: "ok", rawXml };
}

export function resolveAppEncryptFromIncoming(incoming: Record<string, any>): string {
  return String(incoming?.Encrypt ?? "");
}
