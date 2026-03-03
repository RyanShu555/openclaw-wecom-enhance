import type { FileSearchItem } from "./file-search.js";

export type PendingSendList = {
  items: FileSearchItem[];
  dirLabel: string;
  offset: number;
  createdAt: number;
  expiresAt: number;
};

const pendingSendLists = new Map<string, PendingSendList>();
const PENDING_TTL_MS = 10 * 60 * 1000;
export const MAX_LIST_PREVIEW = 30;
export const LIST_MORE_PATTERN = /(更多|下一页|下页|继续|下一批|more|next)/i;

export function makePendingKey(accountId: string, fromUser: string, chatId?: string): string {
  return chatId ? `${accountId}::${fromUser}::${chatId}` : `${accountId}::${fromUser}`;
}

export function prunePendingLists(): void {
  const now = Date.now();
  for (const [key, entry] of pendingSendLists.entries()) {
    if (entry.expiresAt <= now) pendingSendLists.delete(key);
  }
}

setInterval(prunePendingLists, 5 * 60 * 1000).unref();

export function getPendingList(key: string): PendingSendList | undefined {
  return pendingSendLists.get(key);
}

export function clearPendingList(key: string): void {
  pendingSendLists.delete(key);
}

export function setPendingList(params: {
  key: string;
  items: FileSearchItem[];
  dirLabel: string;
}): PendingSendList {
  const pending: PendingSendList = {
    items: params.items,
    dirLabel: params.dirLabel,
    offset: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + PENDING_TTL_MS,
  };
  pendingSendLists.set(params.key, pending);
  return pending;
}

export function movePendingToNextPage(pending: PendingSendList): boolean {
  const nextOffset = pending.offset + MAX_LIST_PREVIEW;
  if (nextOffset >= pending.items.length) {
    return false;
  }
  pending.offset = nextOffset;
  return true;
}

export function buildPendingListText(pending: PendingSendList): { text: string; hasMore: boolean } {
  const start = Math.max(0, pending.offset);
  const total = pending.items.length;
  const slice = pending.items.slice(start, start + MAX_LIST_PREVIEW);
  const preview = slice
    .map((item, idx) => `${start + idx + 1}. ${item.name}`)
    .join("\n");
  const hasMore = start + MAX_LIST_PREVIEW < total;
  const tail = hasMore
    ? `\n…共 ${total} 个文件，回复“更多”查看下一页。`
    : `\n共 ${total} 个文件。`;
  const text = `在${pending.dirLabel}找到 ${total} 个文件：\n${preview}${tail}\n\n回复“全部”或“1 3 5”或直接发送具体文件名。`;
  return { text, hasMore };
}
