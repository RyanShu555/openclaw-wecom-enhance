import type { ServerResponse } from "node:http";

import type { WecomWebhookTarget } from "../monitor.js";
import { decryptEncryptedPayload } from "../shared/webhook-crypto.js";

export function replyBotGetChallenge(params: {
  target: WecomWebhookTarget;
  res: ServerResponse;
  echostr: string;
  onDecryptError?: (message: string) => void;
}): boolean {
  const { target, res, echostr, onDecryptError } = params;
  try {
    const plain = decryptEncryptedPayload({
      encodingAESKey: target.account.encodingAESKey ?? "",
      receiveId: target.account.receiveId ?? "",
      encrypt: echostr,
      allowReceiveIdFallback: true,
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(plain);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onDecryptError?.(msg);
    res.statusCode = 400;
    res.end(msg || "decrypt failed");
    return true;
  }
}

export function decryptBotPostPayload(params: {
  target: WecomWebhookTarget;
  res: ServerResponse;
  encrypt: string;
}): string | null {
  const { target, res, encrypt } = params;
  try {
    return decryptEncryptedPayload({
      encodingAESKey: target.account.encodingAESKey ?? "",
      receiveId: target.account.receiveId ?? "",
      encrypt,
      allowReceiveIdFallback: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.statusCode = 400;
    res.end(msg || "decrypt failed");
    return null;
  }
}
