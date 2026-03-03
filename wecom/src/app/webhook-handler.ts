import type { IncomingMessage, ServerResponse } from "node:http";

import type { WecomWebhookTarget } from "../monitor.js";
import { formatErrorDetail } from "../shared/string-utils.js";
import { replyAppSuccessAck } from "./request-response.js";
import { parseAppXml } from "./xml-parser.js";
import { resolveAppWebhookRequest } from "./request-parser.js";
import { decryptAppPostPayload, replyAppGetChallenge } from "./decrypt-handler.js";

type ProcessAppMessageFn = (params: {
  target: WecomWebhookTarget;
  decryptedXml: string;
  msgObj: Record<string, any>;
}) => Promise<void>;

export async function handleWecomAppWebhookCore(params: {
  req: IncomingMessage;
  res: ServerResponse;
  targets: WecomWebhookTarget[];
  rawBody?: string;
  processAppMessage: ProcessAppMessageFn;
}): Promise<boolean> {
  const { req, res, targets, rawBody, processAppMessage } = params;
  const resolved = await resolveAppWebhookRequest({ req, res, targets, rawBody });
  if (resolved.kind === "skip") return false;
  if (resolved.kind === "handled") return true;
  if (resolved.kind === "get") {
    return replyAppGetChallenge({
      target: resolved.target,
      res,
      echostr: resolved.echostr,
    });
  }
  const { target, encrypt } = resolved;

  replyAppSuccessAck(res);

  let decryptedXml = "";
  try {
    decryptedXml = decryptAppPostPayload({
      target,
      encrypt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    target.runtime.error?.(`wecom app decrypt failed: ${msg}`);
    return true;
  }

  let msgObj: Record<string, any> = {};
  try {
    msgObj = parseAppXml(decryptedXml);
  } catch (err) {
    target.runtime.error?.(`wecom app parse xml failed: ${formatErrorDetail(err)}`);
    return true;
  }

  target.statusSink?.({ lastInboundAt: Date.now() });

  processAppMessage({ target, decryptedXml, msgObj }).catch((err) => {
    target.runtime.error?.(`wecom app async processing failed: ${formatErrorDetail(err)}`);
  });

  return true;
}
