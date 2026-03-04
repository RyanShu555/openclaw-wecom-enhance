export type PushMessage = {
  text?: string;
  mediaUrl?: string;
  mediaPath?: string;
  mediaBase64?: string;
  mediaType?: string;
  filename?: string;
  title?: string;
  description?: string;
  delayMs?: number;
};

export type PushPayload = PushMessage & {
  accountId?: string;
  toUser?: string;
  chatId?: string;
  toParty?: string | string[];
  toTag?: string | string[];
  token?: string;
  intervalMs?: number;
  messages?: PushMessage[];
};
