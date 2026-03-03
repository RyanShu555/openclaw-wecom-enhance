import type { WecomWebhookTarget } from "../monitor.js";
import { sendWecomText } from "../wecom-api.js";
import { sendFilesByPath } from "./file-delivery.js";
import {
  extractFilenameCandidates,
  resolveFileSearchCriteria,
  findFilesByNaturalText,
  type FileSearchItem,
} from "./file-search.js";
import {
  buildPendingListText,
  clearPendingList,
  getPendingList,
  LIST_MORE_PATTERN,
  makePendingKey,
  movePendingToNextPage,
  prunePendingLists,
  setPendingList,
} from "./file-send-state.js";

function parseSelection(text: string, items: FileSearchItem[]): FileSearchItem[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/全部|都要|全都|都给我/.test(trimmed)) return items;
  const picked: FileSearchItem[] = [];
  const numbers = Array.from(trimmed.matchAll(/\d+/g)).map((m) => Number(m[0]));
  if (numbers.length > 0) {
    for (const idx of numbers) {
      const item = items[idx - 1];
      if (item) picked.push(item);
    }
  }
  const names = extractFilenameCandidates(trimmed);
  if (names.length > 0) {
    const map = new Map(items.map((item) => [item.name, item]));
    for (const name of names) {
      const item = map.get(name);
      if (item) picked.push(item);
    }
  }
  return picked.length > 0 ? picked : null;
}

export async function tryHandleNaturalFileSend(params: {
  target: WecomWebhookTarget;
  text: string;
  fromUser: string;
  chatId?: string;
  isGroup: boolean;
}): Promise<boolean> {
  const { target, text, fromUser, chatId, isGroup } = params;
  if (!text || text.trim().startsWith("/")) return false;
  prunePendingLists();
  const key = makePendingKey(target.account.accountId, fromUser, chatId);
  const pending = getPendingList(key);
  if (pending) {
    if (LIST_MORE_PATTERN.test(text)) {
      if (!movePendingToNextPage(pending)) {
        await sendWecomText({
          account: target.account,
          toUser: fromUser,
          chatId: isGroup ? chatId : undefined,
          text: "已经是最后一页了。",
        });
        return true;
      }
      const { text: listText } = buildPendingListText(pending);
      await sendWecomText({
        account: target.account,
        toUser: fromUser,
        chatId: isGroup ? chatId : undefined,
        text: listText,
      });
      return true;
    }
    const selection = parseSelection(text, pending.items);
    if (selection) {
      clearPendingList(key);
      await sendFilesByPath({ target, fromUser, chatId, isGroup, items: selection });
      return true;
    }
  }

  if (!/(发给我|发送给我|发我|给我)/.test(text)) return false;
  const criteria = resolveFileSearchCriteria(text);
  const { exactNames, keywords, ext } = criteria;
  // 没有任何有效搜索条件时，直接返回，避免触发全目录扫描
  if (exactNames.length === 0 && keywords.length === 0 && !ext) return false;

  const {
    resolved,
    foundInDir,
    searchDirs,
    sampleFiles,
  } = await findFilesByNaturalText({ target, text, criteria });

  if (resolved.length === 0) {
    const hint = sampleFiles.length ? `可用文件示例：${sampleFiles.join(", ")}` : "搜索目录中无可用文件";
    const searchedDirs = searchDirs.map((d) => d.label).join("、");
    const searchTerms = [...exactNames, ...keywords].filter(Boolean).join("、") || "(无)";
    await sendWecomText({
      account: target.account,
      toUser: fromUser,
      chatId: isGroup ? chatId : undefined,
      text: `未找到匹配的文件。\n搜索关键词：${searchTerms}\n已搜索：${searchedDirs}\n${hint}`,
    });
    return true;
  }

  if (resolved.length === 1) {
    await sendFilesByPath({ target, fromUser, chatId, isGroup, items: resolved });
    return true;
  }

  const createdPending = setPendingList({
    key,
    items: resolved,
    dirLabel: foundInDir || searchDirs[0]?.label || "搜索结果",
  });
  const { text: listText } = buildPendingListText(createdPending);
  await sendWecomText({
    account: target.account,
    toUser: fromUser,
    chatId: isGroup ? chatId : undefined,
    text: listText,
  });
  return true;
}
