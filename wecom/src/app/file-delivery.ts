import { readFile, stat } from "node:fs/promises";

import type { WecomWebhookTarget } from "../monitor.js";
import { sendWecomFile, sendWecomText, uploadWecomMedia } from "../wecom-api.js";
import { resolveMediaMaxBytes } from "../media-utils.js";
import { appendOperationLog, resolveSendIntervalMs } from "../shared/log-utils.js";
import { formatErrorDetail, sleep } from "../shared/string-utils.js";
import type { FileSearchItem } from "./file-search.js";

export async function sendFilesByPath(params: {
  target: WecomWebhookTarget;
  fromUser: string;
  chatId?: string;
  isGroup: boolean;
  items: FileSearchItem[];
}): Promise<void> {
  const { target, fromUser, chatId, isGroup, items } = params;
  const maxBytes = resolveMediaMaxBytes(target);
  const intervalMs = resolveSendIntervalMs(target.account.config);
  let sent = 0;
  const failed: string[] = [];
  for (const item of items) {
    try {
      const info = await stat(item.path);
      if (maxBytes && info.size > maxBytes) {
        failed.push(`${item.name}(过大)`);
        continue;
      }
      const buffer = await readFile(item.path);
      const mediaId = await uploadWecomMedia({
        account: target.account,
        type: "file",
        buffer,
        filename: item.name,
      });
      await sendWecomFile({
        account: target.account,
        toUser: fromUser,
        chatId: isGroup ? chatId : undefined,
        mediaId,
      });
      sent += 1;
      await appendOperationLog(target.account.config.operations?.logPath, {
        action: "natural-sendfile",
        accountId: target.account.accountId,
        toUser: fromUser,
        chatId,
        path: item.path,
        size: info.size,
      });
      if (intervalMs) await sleep(intervalMs);
    } catch (err) {
      failed.push(item.name);
      await appendOperationLog(target.account.config.operations?.logPath, {
        action: "natural-sendfile",
        accountId: target.account.accountId,
        toUser: fromUser,
        chatId,
        path: item.path,
        error: formatErrorDetail(err),
      });
    }
  }
  const summary = `已发送 ${sent} 个文件${failed.length ? `，失败：${failed.join(", ")}` : ""}`;
  await sendWecomText({
    account: target.account,
    toUser: fromUser,
    chatId: isGroup ? chatId : undefined,
    text: summary,
  });
}
