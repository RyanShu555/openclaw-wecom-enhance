import type { ServerResponse } from "node:http";

import type { WecomWebhookTarget } from "../monitor.js";
import { decryptEncryptedPayload } from "../shared/webhook-crypto.js";

export function replyAppGetChallenge(params: {
  target: WecomWebhookTarget;
  res: ServerResponse;
  echostr: string;
}): boolean {
  const { target, res, echostr } = params;
  try {
    const plain = decryptEncryptedPayload({
      encodingAESKey: target.account.callbackAesKey ?? "",
      receiveId: target.account.corpId ?? "",
      encrypt: echostr,
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(plain);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.statusCode = 400;
    res.end(msg || "decrypt failed");
    return true;
  }
}

export function decryptAppPostPayload(params: {
  target: WecomWebhookTarget;
  encrypt: string;
}): string {
  const { target, encrypt } = params;
  return decryptEncryptedPayload({
    encodingAESKey: target.account.callbackAesKey,
    receiveId: target.account.corpId ?? "",
    encrypt,
  });
}
