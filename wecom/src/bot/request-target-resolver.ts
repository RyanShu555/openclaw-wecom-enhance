import type { WecomWebhookTarget } from "../monitor.js";
import type { ResolvedWecomAccount } from "../types.js";
import { verifyEncryptedSignature } from "../shared/webhook-crypto.js";

export function shouldHandleBot(account: ResolvedWecomAccount): boolean {
  return account.mode === "bot" || account.mode === "both";
}

export function resolveBotTargets(targets: WecomWebhookTarget[]): WecomWebhookTarget[] {
  return targets.filter((candidate) => shouldHandleBot(candidate.account));
}

export function resolveBotGetTargetBySignature(params: {
  targets: WecomWebhookTarget[];
  timestamp: string;
  nonce: string;
  signature: string;
  echostr: string;
}): WecomWebhookTarget | undefined {
  const { targets, timestamp, nonce, signature, echostr } = params;
  return targets.find((candidate) => {
    if (!candidate.account.configured || !candidate.account.token) return false;
    return verifyEncryptedSignature({
      token: candidate.account.token,
      timestamp,
      nonce,
      encrypt: echostr,
      signature,
    });
  });
}

export function resolveBotPostTargetBySignature(params: {
  targets: WecomWebhookTarget[];
  timestamp: string;
  nonce: string;
  signature: string;
  encrypt: string;
}): WecomWebhookTarget | undefined {
  const { targets, timestamp, nonce, signature, encrypt } = params;
  return targets.find((candidate) => {
    if (!candidate.account.token) return false;
    return verifyEncryptedSignature({
      token: candidate.account.token,
      timestamp,
      nonce,
      encrypt,
      signature,
    });
  });
}
