import type { ResolvedWecomAccount } from "../types.js";
import {
  uploadWecomMedia,
  sendWecomMedia,
} from "../wecom-api.js";
import { loadOutboundMedia, mediaSentLabel, type MediaType } from "./media-shared.js";

export type DispatchMediaResult = {
  sent: boolean;
  type?: MediaType;
  label?: string;
};

/**
 * 统一的出站媒体分发：上传 + 按类型发送
 * 用于 bot 回复、app 回复、push 发送等场景
 */
export async function dispatchOutboundMedia(params: {
  payload: any;
  account: ResolvedWecomAccount;
  toUser?: string;
  chatId?: string;
  toParty?: string | string[];
  toTag?: string | string[];
  maxBytes?: number;
  title?: string;
  description?: string;
}): Promise<DispatchMediaResult> {
  const { payload, account, toUser, chatId, toParty, toTag, maxBytes } = params;
  const outbound = await loadOutboundMedia({ payload, account, maxBytes });
  if (!outbound) return { sent: false };

  const mediaId = await uploadWecomMedia({
    account,
    type: outbound.type,
    buffer: outbound.buffer,
    filename: outbound.filename,
  });

  const title = outbound.type === "video"
    ? ((payload as any).title as string | undefined ?? params.title)
    : undefined;
  const description = outbound.type === "video"
    ? ((payload as any).description as string | undefined ?? params.description)
    : undefined;

  await sendWecomMedia({
    account,
    toUser,
    chatId,
    toParty,
    toTag,
    mediaId,
    mediaType: outbound.type,
    title,
    description,
  });

  return { sent: true, type: outbound.type, label: mediaSentLabel(outbound.type) };
}
