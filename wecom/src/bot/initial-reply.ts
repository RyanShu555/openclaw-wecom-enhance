import { jsonOk } from "../shared/http-utils.js";
import { buildEncryptedJsonReply } from "../shared/webhook-crypto.js";
import type { WecomWebhookTarget } from "../monitor.js";
import type { LogVerboseFn } from "./contracts.js";
import {
  buildStreamPlaceholderReply,
  buildStreamReplyFromState,
  msgidToStreamId,
  streams,
  waitForStreamContent,
} from "./state.js";

export function tryReplyBotStreamRefresh(params: {
  target: WecomWebhookTarget;
  res: Parameters<typeof jsonOk>[0];
  streamId: string;
  nonce: string;
  timestamp: string;
  logVerbose: LogVerboseFn;
}): boolean {
  const {
    target,
    res,
    streamId,
    nonce,
    timestamp,
    logVerbose,
  } = params;
  const state = streamId ? streams.get(streamId) : undefined;
  if (state) {
    state.lastRefreshAt = Date.now();
    state.updatedAt = state.lastRefreshAt;
  }
  const reply = state
    ? buildStreamReplyFromState(state)
    : buildStreamReplyFromState({
        streamId: streamId || "unknown",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        started: true,
        finished: true,
        content: "",
      });
  logVerbose(target, `bot stream refresh reply streamId=${streamId || "unknown"} finished=${Boolean(state?.finished)}`);
  jsonOk(res, buildEncryptedJsonReply({
    account: target.account,
    plaintextJson: reply,
    nonce,
    timestamp,
  }));
  return true;
}

export function tryReplyBotExistingMsgidPlaceholder(params: {
  target: WecomWebhookTarget;
  res: Parameters<typeof jsonOk>[0];
  msgtype: string;
  msgid?: string;
  nonce: string;
  timestamp: string;
  logVerbose: LogVerboseFn;
}): boolean {
  const {
    target,
    res,
    msgtype,
    msgid,
    nonce,
    timestamp,
    logVerbose,
  } = params;

  if (msgtype === "event" || !msgid || !msgidToStreamId.has(msgid)) {
    return false;
  }

  const streamId = msgidToStreamId.get(msgid) ?? "";
  const reply = buildStreamPlaceholderReply(streamId);
  logVerbose(target, `bot stream placeholder reply streamId=${streamId || "unknown"}`);
  jsonOk(res, buildEncryptedJsonReply({
    account: target.account,
    plaintextJson: reply,
    nonce,
    timestamp,
  }));
  return true;
}

export async function replyBotInitialAck(params: {
  target: WecomWebhookTarget;
  res: Parameters<typeof jsonOk>[0];
  streamId: string;
  msgid?: string;
  nonce: string;
  timestamp: string;
  logVerbose: LogVerboseFn;
}): Promise<void> {
  const { target, res, streamId, msgid, nonce, timestamp, logVerbose } = params;

  await waitForStreamContent(streamId, 800);
  const state = streams.get(streamId);
  const initialReply = state && (state.content.trim() || state.error)
    ? buildStreamReplyFromState(state)
    : buildStreamPlaceholderReply(streamId);

  logVerbose(
    target,
    `bot initial reply streamId=${streamId} mode=${state && (state.content.trim() || state.error) ? "stream" : "placeholder"}`,
  );
  target.runtime.log?.(`[wecom] bot reply acked streamId=${streamId} msgid=${msgid || "n/a"}`);
  jsonOk(res, buildEncryptedJsonReply({
    account: target.account,
    plaintextJson: initialReply,
    nonce,
    timestamp,
  }));
}
