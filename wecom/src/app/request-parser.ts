import type { IncomingMessage, ServerResponse } from "node:http";

import type { WecomWebhookTarget } from "../monitor.js";
import { resolveAppRequestQuery } from "./request-query.js";
import { parseAppXml } from "./xml-parser.js";
import { resolveAppRequestXml, resolveAppEncryptFromIncoming } from "./request-body.js";
import {
  resolveAppGetTargetBySignature,
  resolveAppPostTargetBySignature,
} from "./request-target-resolver.js";
import {
  replyAppMissingEncrypt,
  replyAppNotConfigured,
} from "./request-response.js";

export { parseAppXml } from "./xml-parser.js";

export type AppResolvedRequest =
  | { kind: "skip" }
  | { kind: "handled" }
  | {
      kind: "get";
      target: WecomWebhookTarget;
      echostr: string;
    }
  | {
      kind: "post";
      target: WecomWebhookTarget;
      encrypt: string;
    };

export async function resolveAppWebhookRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  targets: WecomWebhookTarget[];
  rawBody?: string;
}): Promise<AppResolvedRequest> {
  const { req, res, targets, rawBody } = params;
  const { timestamp, nonce, signature, echostr } = resolveAppRequestQuery(req);

  if (req.method === "GET") {
    if (!timestamp || !nonce || !signature || !echostr) {
      return { kind: "skip" };
    }

    const target = resolveAppGetTargetBySignature({
      targets,
      timestamp,
      nonce,
      signature,
      echostr,
    });

    if (!target || !target.account.callbackAesKey) {
      return { kind: "skip" };
    }

    return { kind: "get", target, echostr };
  }

  if (req.method !== "POST") {
    return { kind: "skip" };
  }

  if (!timestamp || !nonce || !signature) {
    return { kind: "skip" };
  }

  const resolvedXml = await resolveAppRequestXml({ req, res, rawBody });
  if (resolvedXml.kind === "skip") {
    return { kind: "skip" };
  }
  if (resolvedXml.kind === "handled") {
    return { kind: "handled" };
  }
  const { rawXml } = resolvedXml;

  let incoming: Record<string, any>;
  try {
    incoming = parseAppXml(rawXml);
  } catch {
    return { kind: "skip" };
  }

  const encrypt = resolveAppEncryptFromIncoming(incoming);
  if (!encrypt) {
    replyAppMissingEncrypt(res);
    return { kind: "handled" };
  }

  const target = resolveAppPostTargetBySignature({
    targets,
    timestamp,
    nonce,
    signature,
    encrypt,
  });

  if (!target) {
    return { kind: "skip" };
  }

  if (!target.account.callbackAesKey || !target.account.callbackToken) {
    replyAppNotConfigured(res);
    return { kind: "handled" };
  }

  return { kind: "post", target, encrypt };
}
