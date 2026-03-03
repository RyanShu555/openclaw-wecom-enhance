import type { WecomWebhookTarget } from "../monitor.js";
import type { ResolvedWecomAccount } from "../types.js";
import { verifyEncryptedSignature } from "../shared/webhook-crypto.js";

export function shouldHandleApp(account: ResolvedWecomAccount): boolean {
  const mode = account.mode;
  return mode === "app" || mode === "both";
}

export function resolveAppGetTargetBySignature(params: {
  targets: WecomWebhookTarget[];
  timestamp: string;
  nonce: string;
  signature: string;
  echostr: string;
}): WecomWebhookTarget | undefined {
  const { targets, timestamp, nonce, signature, echostr } = params;
  return targets.find((candidate) => {
    if (!shouldHandleApp(candidate.account)) return false;
    const token = candidate.account.callbackToken ?? "";
    const aesKey = candidate.account.callbackAesKey ?? "";
    if (!token || !aesKey) return false;
    return verifyEncryptedSignature({
      token,
      timestamp,
      nonce,
      encrypt: echostr,
      signature,
    });
  });
}

export function resolveAppPostTargetBySignature(params: {
  targets: WecomWebhookTarget[];
  timestamp: string;
  nonce: string;
  signature: string;
  encrypt: string;
}): WecomWebhookTarget | undefined {
  const { targets, timestamp, nonce, signature, encrypt } = params;
  return targets.find((candidate) => {
    if (!shouldHandleApp(candidate.account)) return false;
    const token = candidate.account.callbackToken ?? "";
    const aesKey = candidate.account.callbackAesKey ?? "";
    if (!token || !aesKey) return false;
    return verifyEncryptedSignature({
      token,
      timestamp,
      nonce,
      encrypt,
      signature,
    });
  });
}
