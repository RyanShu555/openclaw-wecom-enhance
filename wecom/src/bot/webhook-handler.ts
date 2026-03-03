import type { IncomingMessage, ServerResponse } from "node:http";

import type { WecomWebhookTarget } from "../monitor.js";
import { hashEncryptPayload } from "./state.js";
import { routeBotPlainMessage } from "./message-router.js";
import { resolveBotWebhookRequest } from "./request-parser.js";
import { parseBotPlainMessage, resolveBotMessageMeta } from "./plain-message-parser.js";
import { tryHandleBotEncryptDedupe } from "./dedupe-handler.js";
import { decryptBotPostPayload, replyBotGetChallenge } from "./decrypt-handler.js";
import type {
  BotQueueLike,
  LogVerboseFn,
  StartAgentForStreamFn,
} from "./contracts.js";


export async function handleWecomBotWebhookCore(params: {
  req: IncomingMessage;
  res: ServerResponse;
  targets: WecomWebhookTarget[];
  rawBody?: string;
  botQueue: BotQueueLike;
  startAgentForStream: StartAgentForStreamFn;
  logVerbose: LogVerboseFn;
}): Promise<boolean> {
  const { req, res, targets, rawBody, botQueue, startAgentForStream, logVerbose } = params;
  const resolved = await resolveBotWebhookRequest({
    req,
    res,
    targets,
    rawBody,
    logVerbose,
  });
  if (resolved.kind === "skip") return false;
  if (resolved.kind === "handled") return true;
  if (resolved.kind === "get") {
    return replyBotGetChallenge({
      target: resolved.target,
      res,
      echostr: resolved.echostr,
      onDecryptError: (msg) => {
        targets[0]?.runtime?.error?.(`[wecom] bot GET decrypt failed: ${msg}`);
      },
    });
  }
  const { target, timestamp, nonce, encrypt } = resolved;

  const encryptHash = hashEncryptPayload(encrypt);
  if (tryHandleBotEncryptDedupe({
    target,
    res,
    encryptHash,
    nonce,
    timestamp,
    logVerbose,
  })) {
    return true;
  }

  const plain = decryptBotPostPayload({
    target,
    res,
    encrypt,
  });
  if (plain == null) {
    return true;
  }

  const msg = parseBotPlainMessage(plain);
  target.statusSink?.({ lastInboundAt: Date.now() });

  const { msgtype, msgid } = resolveBotMessageMeta(msg);
  logVerbose(target, `bot inbound msgtype=${msgtype || "unknown"} msgid=${msgid || "n/a"}`);

  return routeBotPlainMessage({
    target,
    res,
    msg,
    msgtype,
    msgid,
    nonce,
    timestamp,
    encryptHash,
    botQueue,
    startAgentForStream,
    logVerbose,
  });
}
