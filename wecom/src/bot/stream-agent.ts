import type { WecomWebhookTarget } from "../monitor.js";
import type { WecomInboundMessage } from "../types.js";
import {
  formatErrorDetail,
} from "../shared/string-utils.js";
import { buildAgentContext } from "../shared/agent-context.js";
import { buildInboundImages } from "../shared/inbound-images.js";
import { resolveMediaMaxBytes } from "../media-utils.js";
import { buildInboundBody } from "./media-inbound.js";
import {
  streams,
} from "./state.js";
import {
  flushFallbackDmIfNeeded,
} from "./stream-fallback.js";
import { deliverStreamPayload } from "./stream-deliver.js";
import { scheduleFinalResponseUrlPush } from "./stream-response-url.js";

export async function startAgentForStream(params: {
  target: WecomWebhookTarget;
  msg: WecomInboundMessage;
  streamId: string;
  logVerbose: (target: WecomWebhookTarget, message: string) => void;
}): Promise<void> {
  const { target, msg, streamId, logVerbose } = params;
  const account = target.account;

  const userid = msg.from?.userid?.trim() || "unknown";
  const chatType = msg.chattype === "group" ? "group" : "direct";
  const chatId = msg.chattype === "group" ? (msg.chatid?.trim() || "unknown") : userid;
  const inbound = await buildInboundBody({ target, msg });
  const rawBody = inbound.text;
  const inboundImages = await buildInboundImages(inbound.media, resolveMediaMaxBytes(target));

  const { core, route, storePath, ctxPayload, tableMode } = buildAgentContext({
    target,
    surface: "bot",
    fromUser: userid,
    chatId: chatType === "group" ? chatId : undefined,
    isGroup: chatType === "group",
    messageText: rawBody,
    messageSid: msg.msgid ? String(msg.msgid) : undefined,
    media: inbound.media,
  });

  logVerbose(target, `starting agent processing (streamId=${streamId}, agentId=${route.agentId}, peerKind=${chatType}, peerId=${chatId})`);

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      target.runtime.error?.(`wecom: failed updating session meta: ${formatErrorDetail(err)}`);
    },
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: target.config,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverStreamPayload({
          target,
          streamId,
          userId: userid,
          chatType,
          chatId,
          tableMode,
          payload,
          convertMarkdownTables: (text, mode) => core.channel.text.convertMarkdownTables(text, mode),
        });
      },
      onError: (err, info) => {
        target.runtime.error?.(`[${account.accountId}] wecom ${info.kind} reply failed: ${formatErrorDetail(err)}`);
      },
    },
    replyOptions: {
      images: inboundImages,
    },
  });

  const current = streams.get(streamId);
  if (current) {
    const finishedAt = Date.now();
    current.finished = true;
    current.finishedAt = finishedAt;
    current.updatedAt = finishedAt;
    await flushFallbackDmIfNeeded({ target, state: current, userId: userid });
    scheduleFinalResponseUrlPush({ target, streamId });
  }
}
