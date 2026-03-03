import crypto from "node:crypto";

import type { WecomWebhookTarget } from "../monitor.js";

export function shouldHandleAppTarget(target: WecomWebhookTarget): boolean {
  const mode = target.account.mode;
  return mode === "app" || mode === "both";
}

export function selectPushTarget(targets: WecomWebhookTarget[], accountId?: string): WecomWebhookTarget | undefined {
  const appTargets = targets.filter((candidate) => shouldHandleAppTarget(candidate));
  if (!accountId) return appTargets[0];
  return appTargets.find((candidate) => candidate.account.accountId === accountId);
}

export function resolvePushToken(target: WecomWebhookTarget): string {
  return target.account.config.pushToken?.trim() || "";
}

export function isPushTokenMatch(expectedToken: string, requestToken: string): boolean {
  if (!expectedToken || !requestToken) return false;
  const a = Buffer.from(expectedToken, "utf8");
  const b = Buffer.from(requestToken, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
