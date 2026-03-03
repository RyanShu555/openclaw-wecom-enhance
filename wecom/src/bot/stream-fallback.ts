import type { WecomWebhookTarget } from "../monitor.js";
import { sendWecomText } from "../wecom-api.js";
import {
  truncateUtf8Bytes,
  formatErrorDetail,
} from "../shared/string-utils.js";
import {
  STREAM_MAX_BYTES,
  type StreamState,
} from "./state.js";

const BOT_WINDOW_MS = 6 * 60 * 1000;
const BOT_SWITCH_MARGIN_MS = 30 * 1000;

function buildFallbackPrompt(params: {
  kind: "media" | "timeout" | "error";
  agentConfigured: boolean;
  userId?: string;
}): string {
  if (!params.agentConfigured) {
    return "需要通过应用私信发送，但管理员尚未配置企业微信自建应用（Agent）通道。请联系管理员配置后再试。";
  }
  if (!params.userId) {
    return "需要通过应用私信兜底发送，但未能识别触发者 userid。请联系管理员排查配置。";
  }
  if (params.kind === "timeout") {
    return "内容较长，为避免超时，后续内容将通过应用私信发送给你。";
  }
  if (params.kind === "media") {
    return "已生成文件，将通过应用私信发送给你。";
  }
  return "交付出现异常，已尝试通过应用私信发送给你。";
}

function shouldFallbackToDm(state: StreamState): boolean {
  if (state.fallbackMode) return false;
  return Date.now() - state.createdAt >= BOT_WINDOW_MS - BOT_SWITCH_MARGIN_MS;
}

export function appendDmContent(state: StreamState, text: string): void {
  const next = state.dmContent ? `${state.dmContent}\n\n${text}`.trim() : text.trim();
  state.dmContent = truncateUtf8Bytes(next, 200_000);
}

export function tryEnterTimeoutFallback(params: {
  state: StreamState;
  userId: string;
  agentConfigured: boolean;
}): void {
  const { state, userId, agentConfigured } = params;
  if (!shouldFallbackToDm(state) || !agentConfigured || userId === "unknown") {
    return;
  }
  state.fallbackMode = "timeout";
  const prompt = buildFallbackPrompt({ kind: "timeout", agentConfigured, userId });
  if (state.content.trim()) appendDmContent(state, state.content);
  state.content = truncateUtf8Bytes(
    state.content ? `${state.content}\n\n${prompt}` : prompt,
    STREAM_MAX_BYTES,
  );
  state.updatedAt = Date.now();
}

export async function flushFallbackDmIfNeeded(params: {
  target: WecomWebhookTarget;
  state: StreamState;
  userId: string;
}): Promise<void> {
  const { target, state, userId } = params;
  if (!state.fallbackMode || !state.dmContent?.trim() || userId === "unknown") {
    return;
  }

  const account = target.account;
  const agentConfigured = Boolean(account.corpId && account.corpSecret && account.agentId);
  if (!agentConfigured) {
    return;
  }

  try {
    await sendWecomText({ account, toUser: userId, text: state.dmContent.trim() });
    target.statusSink?.({ lastOutboundAt: Date.now() });
  } catch (err) {
    target.runtime.error?.(`[${account.accountId}] wecom bot DM fallback failed: ${formatErrorDetail(err)}`);
  }
}
