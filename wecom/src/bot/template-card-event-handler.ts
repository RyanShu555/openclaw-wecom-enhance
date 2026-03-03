import { jsonOk } from "../shared/http-utils.js";
import { buildEncryptedJsonReply } from "../shared/webhook-crypto.js";
import type { WecomWebhookTarget } from "../monitor.js";
import type { WecomInboundMessage } from "../types.js";
import {
  createStreamId,
  msgidToStreamId,
  recentEncrypts,
  streams,
} from "./state.js";
import type { LogVerboseFn, StartAgentForStreamFn } from "./contracts.js";
import { startBotStreamAgentOrFinish } from "./stream-runner.js";

function buildTemplateCardInteractionDesc(msg: WecomInboundMessage): string {
  const cardEvent = (msg as any).event?.template_card_event;
  let interactionDesc = `[卡片交互] 按钮: ${cardEvent?.event_key || "unknown"}`;
  const selected = cardEvent?.selected_items?.selected_item;
  if (Array.isArray(selected) && selected.length > 0) {
    const selects = selected.map((item: any) => {
      const key = item?.question_key || "unknown";
      const options = Array.isArray(item?.option_ids?.option_id)
        ? item.option_ids.option_id.join(",")
        : "";
      return `${key}=${options}`;
    }).join("; ");
    if (selects) interactionDesc += ` 选择: ${selects}`;
  }
  if (cardEvent?.task_id) interactionDesc += ` (任务ID: ${cardEvent.task_id})`;
  return interactionDesc;
}

export function handleTemplateCardEvent(params: {
  target: WecomWebhookTarget;
  res: Parameters<typeof jsonOk>[0];
  msg: WecomInboundMessage;
  msgid?: string;
  nonce: string;
  timestamp: string;
  encryptHash: string;
  startAgentForStream: StartAgentForStreamFn;
  logVerbose: LogVerboseFn;
}): boolean {
  const {
    target,
    res,
    msg,
    msgid,
    nonce,
    timestamp,
    encryptHash,
    startAgentForStream,
    logVerbose,
  } = params;

  if (msgid && msgidToStreamId.has(msgid)) {
    jsonOk(res, buildEncryptedJsonReply({
      account: target.account,
      plaintextJson: {},
      nonce,
      timestamp,
    }));
    return true;
  }

  const interactionDesc = buildTemplateCardInteractionDesc(msg);

  jsonOk(res, buildEncryptedJsonReply({
    account: target.account,
    plaintextJson: {},
    nonce,
    timestamp,
  }));

  const streamId = createStreamId();
  if (msgid) msgidToStreamId.set(msgid, streamId);
  streams.set(streamId, {
    streamId,
    msgid,
    responseUrl: typeof (msg as any).response_url === "string" ? String((msg as any).response_url).trim() : undefined,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    started: true,
    finished: false,
    content: "",
  });
  recentEncrypts.set(encryptHash, { ts: Date.now(), streamId });

  const eventMsg = {
    ...msg,
    msgtype: "text",
    text: { content: interactionDesc },
  } as WecomInboundMessage;
  startBotStreamAgentOrFinish({
    target,
    msg: eventMsg,
    streamId,
    startAgentForStream,
    onRuntimeNotReady: (err) => {
      logVerbose(target, `runtime not ready, skipping agent processing: ${String(err)}`);
    },
  });

  return true;
}
