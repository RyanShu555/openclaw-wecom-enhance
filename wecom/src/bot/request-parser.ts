import type { IncomingMessage, ServerResponse } from "node:http";

import type { WecomWebhookTarget } from "../monitor.js";
import { resolveBotRequestQuery } from "./request-query.js";
import { resolveBotRequestRecord, resolveBotEncryptFromRecord } from "./request-body.js";
import {
  resolveBotGetTargetBySignature,
  resolveBotPostTargetBySignature,
  resolveBotTargets,
} from "./request-target-resolver.js";
import {
  replyBotMissingEncrypt,
  replyBotNotConfigured,
} from "./request-response.js";

export type BotResolvedRequest =
  | { kind: "skip" }
  | { kind: "handled" }
  | {
      kind: "get";
      target: WecomWebhookTarget;
      timestamp: string;
      nonce: string;
      echostr: string;
    }
  | {
      kind: "post";
      target: WecomWebhookTarget;
      timestamp: string;
      nonce: string;
      encrypt: string;
    };

export async function resolveBotWebhookRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  targets: WecomWebhookTarget[];
  rawBody?: string;
  logVerbose: (target: WecomWebhookTarget, message: string) => void;
}): Promise<BotResolvedRequest> {
  const { req, res, targets, rawBody, logVerbose } = params;

  const botTargets = resolveBotTargets(targets);
  if (botTargets.length === 0) {
    return { kind: "skip" };
  }

  const { timestamp, nonce, signature, echostr } = resolveBotRequestQuery(req);

  const firstTarget = targets[0]!;
  logVerbose(firstTarget, `incoming ${req.method} request (timestamp=${timestamp}, nonce=${nonce}, signature=${signature})`);

  if (req.method === "GET") {
    if (!timestamp || !nonce || !signature || !echostr) {
      targets[0]?.runtime?.log?.(
        `[wecom] bot GET missing params (timestamp=${Boolean(timestamp)} nonce=${Boolean(nonce)} signature=${Boolean(signature)} echostr=${Boolean(echostr)})`,
      );
      return { kind: "skip" };
    }

    const target = resolveBotGetTargetBySignature({
      targets: botTargets,
      timestamp,
      nonce,
      signature,
      echostr,
    });
    if (!target || !target.account.encodingAESKey) {
      targets[0]?.runtime?.log?.("[wecom] bot GET signature verify failed");
      return { kind: "skip" };
    }

    return { kind: "get", target, timestamp, nonce, echostr };
  }

  if (req.method !== "POST") {
    return { kind: "skip" };
  }

  if (!timestamp || !nonce || !signature) {
    return { kind: "skip" };
  }

  const resolvedRecord = await resolveBotRequestRecord({ req, res, rawBody });
  if (resolvedRecord.kind === "skip") {
    return { kind: "skip" };
  }
  if (resolvedRecord.kind === "handled") {
    return { kind: "handled" };
  }
  const { record } = resolvedRecord;

  const encrypt = resolveBotEncryptFromRecord(record);
  if (!encrypt) {
    replyBotMissingEncrypt(res);
    return { kind: "handled" };
  }

  const target = resolveBotPostTargetBySignature({
    targets: botTargets,
    timestamp,
    nonce,
    signature,
    encrypt,
  });
  if (!target) {
    return { kind: "skip" };
  }

  if (!target.account.configured || !target.account.token || !target.account.encodingAESKey) {
    replyBotNotConfigured(res);
    return { kind: "handled" };
  }

  return { kind: "post", target, timestamp, nonce, encrypt };
}
