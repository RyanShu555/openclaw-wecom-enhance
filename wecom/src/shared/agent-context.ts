import type { WecomWebhookTarget } from "../monitor.js";
import { getWecomRuntime } from "../runtime.js";
import { shouldUseDynamicAgent, generateAgentId, ensureDynamicAgentListed } from "../dynamic-agent.js";

export type AgentContextParams = {
  target: WecomWebhookTarget;
  fromUser: string;
  chatId?: string;
  isGroup: boolean;
  messageText: string;
  messageSid?: string;
  media?: {
    path: string;
    type: string;
    mimeType?: string;
    url?: string;
  } | null;
};

export type AgentContextResult = {
  core: ReturnType<typeof getWecomRuntime>;
  route: { agentId: string; accountId: string; sessionKey: string };
  storePath: string;
  ctxPayload: Record<string, any>;
  tableMode: any;
  fromLabel: string;
  peerId: string;
};

/**
 * 构建 agent 上下文（bot 和 app 共用）
 */
export function buildAgentContext(params: AgentContextParams): AgentContextResult {
  const { target, fromUser, chatId, isGroup, messageText, messageSid, media } = params;
  const core = getWecomRuntime();
  const config = target.config;
  const account = target.account;

  const peerId = isGroup ? (chatId || "unknown") : fromUser;
  const chatType = isGroup ? "group" : "direct";
  const fromLabel = isGroup ? `group:${peerId}` : `user:${fromUser}`;

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
    peer: { kind: isGroup ? "group" : "dm", id: peerId },
  });

  // 动态 Agent 路由覆盖
  const dynamicCfg = account.config.dynamicAgents;
  if (shouldUseDynamicAgent({ config: dynamicCfg, userId: fromUser, isGroup })) {
    const dynamicId = generateAgentId({ userId: fromUser, chatId, isGroup });
    route.agentId = dynamicId;
    route.sessionKey = `${dynamicId}:${peerId}`;
    // 异步注册，不阻塞消息处理
    ensureDynamicAgentListed({
      core,
      agentId: dynamicId,
      label: isGroup ? `WeCom 群聊 ${chatId}` : `WeCom 用户 ${fromUser}`,
    }).catch(() => {});
  }

  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "WeCom",
    from: fromLabel,
    previousTimestamp,
    envelope: envelopeOptions,
    body: messageText,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: messageText,
    CommandBody: messageText,
    From: isGroup ? `wecom:group:${peerId}` : `wecom:${fromUser}`,
    To: `wecom:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: fromUser,
    SenderId: fromUser,
    Provider: "wecom",
    Surface: "wecom",
    MessageSid: messageSid ?? `wecom-${Date.now()}`,
    OriginatingChannel: "wecom",
    OriginatingTo: `wecom:${peerId}`,
  });

  if (media?.path) {
    ctxPayload.MediaPath = media.path;
    ctxPayload.MediaType = media.type;
    if (media.mimeType) {
      (ctxPayload as any).MediaMimeType = media.mimeType;
    }
    if (media.url) {
      ctxPayload.MediaUrl = media.url;
    }
  }

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
  });

  return { core, route, storePath, ctxPayload, tableMode, fromLabel, peerId };
}
