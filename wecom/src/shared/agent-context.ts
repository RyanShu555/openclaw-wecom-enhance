import type { WecomWebhookTarget } from "../monitor.js";
import { getWecomRuntime } from "../runtime.js";
import { shouldUseDynamicAgent, generateAgentId, ensureDynamicAgentListed } from "../dynamic-agent.js";

export type AgentContextParams = {
  target: WecomWebhookTarget;
  surface: "app" | "bot";
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
  sessionKey: string;
  storePath: string;
  ctxPayload: Record<string, any>;
  tableMode: any;
  fromLabel: string;
  peerId: string;
};

function resolveInboundMediaMime(media: NonNullable<AgentContextParams["media"]>): string {
  if (media.mimeType?.trim()) return media.mimeType.trim();
  const type = media.type?.toLowerCase();
  if (type === "image") return "image/jpeg";
  if (type === "voice") return "audio/amr";
  if (type === "video") return "video/mp4";
  return "application/octet-stream";
}

export function buildWecomSessionKey(params: {
  surface: "app" | "bot";
  accountId: string;
  agentId: string;
  chatType: "group" | "direct";
  peerId: string;
}): string {
  const { surface, accountId, agentId, chatType, peerId } = params;
  return `wecom:${surface}:${accountId}:${agentId}:${chatType}:${peerId}`;
}

/**
 * 构建 agent 上下文（bot 和 app 共用）
 */
export function buildAgentContext(params: AgentContextParams): AgentContextResult {
  const { target, surface, fromUser, chatId, isGroup, messageText, messageSid, media } = params;
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

  const sessionKey = buildWecomSessionKey({
    surface,
    accountId: route.accountId,
    agentId: route.agentId,
    chatType,
    peerId,
  });
  route.sessionKey = sessionKey;

  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });

  const normalizedMessageText = messageText.trim();
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = normalizedMessageText
    ? core.channel.reply.formatAgentEnvelope({
      channel: "WeCom",
      from: fromLabel,
      previousTimestamp,
      envelope: envelopeOptions,
      body: normalizedMessageText,
    })
    : "";

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: normalizedMessageText,
    CommandBody: normalizedMessageText,
    From: isGroup ? `wecom:group:${peerId}` : `wecom:${fromUser}`,
    To: `wecom:${peerId}`,
    SessionKey: sessionKey,
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
    const mediaPath = media.path;
    const mediaUrl = media.url || mediaPath;
    const mediaType = resolveInboundMediaMime(media);
    ctxPayload.MediaPath = mediaPath;
    ctxPayload.MediaUrl = mediaUrl;
    ctxPayload.MediaType = mediaType;
    ctxPayload.MediaPaths = [mediaPath];
    ctxPayload.MediaUrls = [mediaUrl];
    ctxPayload.MediaTypes = [mediaType];
    (ctxPayload as any).MediaMimeType = mediaType;
  }

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: config,
    channel: "wecom",
    accountId: account.accountId,
  });

  return { core, route, sessionKey, storePath, ctxPayload, tableMode, fromLabel, peerId };
}
