import type { WecomWebhookTarget } from "../monitor.js";
import { formatErrorDetail } from "../shared/string-utils.js";
import type { StreamState } from "./state.js";

function buildTemplateCardFallbackText(templateCard: Record<string, unknown>): string {
  const cardTitle = (templateCard as any)?.main_title?.title || "交互卡片";
  const cardDesc = (templateCard as any)?.main_title?.desc || "";
  const buttons = Array.isArray((templateCard as any)?.button_list)
    ? (templateCard as any).button_list.map((b: any) => b?.text).filter(Boolean).join(" / ")
    : "";
  return `【交互卡片】${cardTitle}${cardDesc ? `\n${cardDesc}` : ""}${buttons ? `\n\n选项: ${buttons}` : ""}`;
}

export async function tryHandleTemplateCardText(params: {
  target: WecomWebhookTarget;
  accountId: string;
  chatType: "group" | "direct";
  state: StreamState;
  text: string;
}): Promise<{ consumed: boolean; text: string }> {
  const { target, accountId, chatType, state, text } = params;
  const trimmedText = text.trim();
  if (!trimmedText.startsWith("{") || !trimmedText.includes("\"template_card\"")) {
    return { consumed: false, text };
  }

  try {
    const parsed = JSON.parse(trimmedText) as { template_card?: Record<string, unknown> };
    if (!parsed.template_card) {
      return { consumed: false, text };
    }

    const isSingleChat = chatType !== "group";
    const responseUrl = state.responseUrl;
    if (isSingleChat && responseUrl) {
      try {
        const res = await fetch(responseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msgtype: "template_card", template_card: parsed.template_card }),
        });
        if (!res.ok) {
          throw new Error(`response_url status ${res.status}`);
        }
        state.finished = true;
        state.content = state.content || "[已发送交互卡片]";
        state.updatedAt = Date.now();
        target.statusSink?.({ lastOutboundAt: Date.now() });
        return { consumed: true, text: state.content };
      } catch (err) {
        target.runtime.error?.(
          `[${accountId}] wecom bot template_card send failed: ${formatErrorDetail(err)}`,
        );
      }
    }

    return {
      consumed: false,
      text: buildTemplateCardFallbackText(parsed.template_card),
    };
  } catch {
    return { consumed: false, text };
  }
}
