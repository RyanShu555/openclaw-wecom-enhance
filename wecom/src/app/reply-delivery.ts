import type { WecomWebhookTarget } from "../monitor.js";
import { markdownToWecomText } from "../format.js";
import { sendWecomText } from "../wecom-api.js";
import { resolveMediaMaxBytes } from "../media-utils.js";
import { formatErrorDetail } from "../shared/string-utils.js";
import { dispatchOutboundMedia } from "../shared/dispatch-media.js";
import { buildAgentContext } from "../shared/agent-context.js";
import { buildInboundImages } from "../shared/inbound-images.js";

export type AppMediaContext = {
  type: "image" | "voice" | "video" | "file";
  path: string;
  mimeType?: string;
  url?: string;
} | null;

function logVerbose(target: WecomWebhookTarget, message: string): void {
  target.runtime.log?.(`[wecom] ${message}`);
}

export async function startAgentForApp(params: {
  target: WecomWebhookTarget;
  fromUser: string;
  chatId?: string;
  isGroup: boolean;
  messageText: string;
  media?: AppMediaContext;
}): Promise<void> {
  const { target, fromUser, chatId, isGroup, messageText, media } = params;
  const account = target.account;
  const maxMediaBytes = resolveMediaMaxBytes(target);

  const { core, route, storePath, ctxPayload, tableMode } = buildAgentContext({
    target,
    surface: "app",
    fromUser,
    chatId,
    isGroup,
    messageText,
    media,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      target.runtime.error?.(`wecom: failed updating session meta: ${formatErrorDetail(err)}`);
    },
  });

  (core.channel as any)?.activity?.record?.({
    channel: "wecom",
    accountId: account.accountId,
    direction: "inbound",
  });
  const inboundImages = await buildInboundImages(media, maxMediaBytes);

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: target.config,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        try {
          const result = await dispatchOutboundMedia({
            payload,
            account,
            toUser: fromUser,
            chatId: isGroup ? chatId : undefined,
            maxBytes: maxMediaBytes,
          });
          if (result.sent) {
            logVerbose(target, `app ${result.type} reply delivered (${info.kind}) to ${fromUser}`);
            target.statusSink?.({ lastOutboundAt: Date.now() });
          }
        } catch (err) {
          target.runtime.error?.(`[${account.accountId}] wecom app media reply failed: ${formatErrorDetail(err)}`);
        }

        const text = markdownToWecomText(core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode));
        if (!text) return;
        try {
          await sendWecomText({ account, toUser: fromUser, chatId: isGroup ? chatId : undefined, text });
          (core.channel as any)?.activity?.record?.({
            channel: "wecom",
            accountId: account.accountId,
            direction: "outbound",
          });
          target.statusSink?.({ lastOutboundAt: Date.now() });
          logVerbose(target, `app reply delivered (${info.kind}) to ${fromUser}`);
        } catch (err) {
          target.runtime.error?.(`[${account.accountId}] wecom app text reply failed: ${formatErrorDetail(err)}`);
        }
      },
      onError: (err, info) => {
        target.runtime.error?.(`[${account.accountId}] wecom app ${info.kind} reply failed: ${formatErrorDetail(err)}`);
      },
    },
    replyOptions: {
      disableBlockStreaming: true,
      images: inboundImages,
    },
  });
}
