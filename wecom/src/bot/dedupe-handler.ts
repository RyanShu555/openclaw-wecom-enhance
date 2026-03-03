import { jsonOk } from "../shared/http-utils.js";
import { buildEncryptedJsonReply } from "../shared/webhook-crypto.js";
import type { WecomWebhookTarget } from "../monitor.js";
import type { LogVerboseFn } from "./contracts.js";
import {
  DEDUPE_TTL_MS,
  buildStreamPlaceholderReply,
  buildStreamReplyFromState,
  recentEncrypts,
  streams,
} from "./state.js";

export function tryHandleBotEncryptDedupe(params: {
  target: WecomWebhookTarget;
  res: Parameters<typeof jsonOk>[0];
  encryptHash: string;
  nonce: string;
  timestamp: string;
  logVerbose: LogVerboseFn;
}): boolean {
  const { target, res, encryptHash, nonce, timestamp, logVerbose } = params;
  const dedupeEntry = recentEncrypts.get(encryptHash);
  if (!dedupeEntry || Date.now() - dedupeEntry.ts > DEDUPE_TTL_MS) {
    if (dedupeEntry) {
      recentEncrypts.delete(encryptHash);
    }
    return false;
  }

  const streamId = dedupeEntry.streamId ?? "";
  const state = streamId ? streams.get(streamId) : undefined;
  if (!streamId || !state) {
    recentEncrypts.delete(encryptHash);
    return false;
  }

  const reply = state.error || state.content.trim()
    ? buildStreamReplyFromState(state)
    : buildStreamPlaceholderReply(streamId);
  state.lastRefreshAt = Date.now();
  state.updatedAt = state.lastRefreshAt;
  logVerbose(target, `bot dedupe hit streamId=${streamId}`);
  jsonOk(res, buildEncryptedJsonReply({
    account: target.account,
    plaintextJson: reply,
    nonce,
    timestamp,
  }));
  dedupeEntry.ts = Date.now();
  return true;
}
