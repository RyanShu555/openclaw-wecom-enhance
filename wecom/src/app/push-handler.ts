import type { IncomingMessage, ServerResponse } from "node:http";

import type { WecomWebhookTarget } from "../monitor.js";
import { formatErrorDetail } from "../shared/string-utils.js";
import type { PushPayload } from "./push-types.js";
import {
  isPushTokenMatch,
  resolvePushToken,
  selectPushTarget,
} from "./push-target-auth.js";
import { dispatchPushMessages } from "./push-delivery.js";
import {
  PushPayloadTooLargeError,
  resolvePushPayload,
  resolvePushRequestParams,
} from "./push-request.js";
import {
  replyPushAppNotConfigured,
  replyPushInvalidJson,
  replyPushMethodNotAllowed,
  replyPushMissingRecipient,
  replyPushNoMatchingAccount,
  replyPushPayloadTooLarge,
  replyPushSuccess,
  replyPushTokenInvalid,
  replyPushTokenNotConfigured,
} from "./push-response.js";

export async function handleWecomPushRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  targets: WecomWebhookTarget[];
}): Promise<boolean> {
  const { req, res, targets } = params;
  if ((req.method ?? "").toUpperCase() !== "POST") {
    replyPushMethodNotAllowed(res);
    return true;
  }

  let payload: PushPayload;
  try {
    payload = await resolvePushPayload(req);
  } catch (err) {
    if (err instanceof PushPayloadTooLargeError) {
      replyPushPayloadTooLarge(res);
      return true;
    }
    replyPushInvalidJson(res, formatErrorDetail(err));
    return true;
  }

  const { accountId, toUser, chatId, requestToken } = resolvePushRequestParams(req, payload);
  const target = selectPushTarget(targets, accountId);
  if (!target) {
    replyPushNoMatchingAccount(res);
    return true;
  }

  const expectedToken = resolvePushToken(target);
  if (!expectedToken) {
    target.runtime.error?.("[wecom] push endpoint rejected: pushToken not configured. Set pushToken in account config to enable push.");
    replyPushTokenNotConfigured(res);
    return true;
  }
  if (!isPushTokenMatch(expectedToken, requestToken)) {
    replyPushTokenInvalid(res);
    return true;
  }

  if (!toUser && !chatId) {
    replyPushMissingRecipient(res);
    return true;
  }

  if (!target.account.corpId || !target.account.corpSecret || !target.account.agentId) {
    replyPushAppNotConfigured(res);
    return true;
  }

  const sent = await dispatchPushMessages({
    target,
    payload,
    toUser,
    chatId,
  });

  target.statusSink?.({ lastOutboundAt: Date.now() });
  replyPushSuccess(res, sent);
  return true;
}
