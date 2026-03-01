import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { WecomWebhookTarget } from "./monitor.js";
import { decryptWecomEncrypted, verifyWecomSignature } from "./crypto.js";
import { handleCommand } from "./commands.js";
import { markdownToWecomText } from "./format.js";
import {
  sendWecomText,
  uploadWecomMedia,
  sendWecomFile,
} from "./wecom-api.js";
import {
  resolveMediaMaxBytes,
  resolveMediaTempDir,
} from "./media-utils.js";
import {
  readRequestBody,
  resolveHeaderToken,
  resolveQueryParams,
  resolveSignatureParam,
} from "./shared/http-utils.js";
import {
  pickString,
  sleep,
} from "./shared/string-utils.js";
import {
  appendOperationLog,
  resolveSendIntervalMs,
} from "./shared/log-utils.js";
import {
  getCachedMedia,
  MEDIA_CACHE_MAX_ENTRIES,
  type MediaCacheEntry,
  storeCachedMedia,
} from "./shared/cache-utils.js";
import { dispatchOutboundMedia } from "./shared/dispatch-media.js";
import { buildAgentContext } from "./shared/agent-context.js";
import { processInboundMedia } from "./shared/media-inbound.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  processEntities: false,
});

const MAX_REQUEST_BODY_SIZE = 1024 * 1024;

const mediaCache = new Map<string, MediaCacheEntry>();

function parseIncomingXml(xml: string): Record<string, any> {
  const obj = xmlParser.parse(xml);
  const root = (obj as any)?.xml ?? obj;
  return root ?? {};
}

function shouldHandleApp(target: WecomWebhookTarget): boolean {
  const mode = target.account.mode;
  return mode === "app" || mode === "both";
}

type PendingSendList = {
  items: { name: string; path: string }[];
  dirLabel: string;
  offset: number;
  createdAt: number;
  expiresAt: number;
};

const pendingSendLists = new Map<string, PendingSendList>();
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_LIST_PREVIEW = 30;
const LIST_MORE_PATTERN = /(更多|下一页|下页|继续|下一批|more|next)/i;

function pendingKey(accountId: string, fromUser: string, chatId?: string): string {
  return chatId ? `${accountId}::${fromUser}::${chatId}` : `${accountId}::${fromUser}`;
}

function prunePendingLists(): void {
  const now = Date.now();
  for (const [key, entry] of pendingSendLists.entries()) {
    if (entry.expiresAt <= now) pendingSendLists.delete(key);
  }
}

function extractFilenameCandidates(text: string): string[] {
  const candidates = new Set<string>();
  const normalized = text.replace(/[，,；;|]/g, " ");
  // 匹配带扩展名的文件名
  const regex = /(?:\/|file:\/\/)?[A-Za-z0-9\u4e00-\u9fa5._-]+\.[A-Za-z0-9]{1,8}/g;
  for (const match of normalized.matchAll(regex)) {
    const value = match[0];
    if (value) candidates.add(value.replace(/^file:\/\//, ""));
  }
  return Array.from(candidates);
}

/** 从自然语言中提取搜索关键词 */
function extractSearchKeywords(text: string): string[] {
  const keywords = new Set<string>();
  // 移除常见的动词和介词
  const cleaned = text
    .replace(/(发给我|发送给我|发我|给我|把|那个|这个|文件|帮我|找|搜索|查找)/g, " ")
    .replace(/[，,；;|。！？\s]+/g, " ")
    .trim();

  // 提取中文词汇（2-10个字符）
  const chineseWords = cleaned.match(/[\u4e00-\u9fa5]{2,10}/g) || [];
  for (const word of chineseWords) {
    if (word.length >= 2) keywords.add(word);
  }

  // 提取英文词汇（2个以上字符）
  const englishWords = cleaned.match(/[A-Za-z][A-Za-z0-9_-]{1,}/g) || [];
  for (const word of englishWords) {
    keywords.add(word.toLowerCase());
  }

  // 提取数字序列（可能是日期、版本号等）
  const numbers = cleaned.match(/\d{2,}/g) || [];
  for (const num of numbers) {
    keywords.add(num);
  }

  return Array.from(keywords);
}

function extractExtension(text: string): string | null {
  const match = text.match(/(?:\.|格式|后缀)?\s*([A-Za-z0-9]{2,8})/i);
  if (!match) return null;
  const ext = match[1]?.toLowerCase();
  if (!ext) return null;
  const allowed = new Set([
    "png", "jpg", "jpeg", "gif", "bmp", "webp",
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "zip", "rar", "7z",
    "txt", "log", "csv", "json", "xml", "yaml", "yml",
    "mp3", "wav", "amr", "mp4", "mov",
  ]);
  return allowed.has(ext) ? ext : null;
}

function resolveSearchDirs(text: string, target: WecomWebhookTarget): { path: string; label: string; recursive?: boolean }[] {
  const lower = text.toLowerCase();
  // 如果明确指定了目录，只搜索该目录
  if (text.includes("桌面")) return [{ path: join(homedir(), "Desktop"), label: "桌面", recursive: true }];
  if (text.includes("下载") || lower.includes("download")) return [{ path: join(homedir(), "Downloads"), label: "下载", recursive: true }];
  if (text.includes("文档") || lower.includes("document")) return [{ path: join(homedir(), "Documents"), label: "文档", recursive: true }];
  if (text.includes("临时") || lower.includes("tmp")) return [{ path: resolveMediaTempDir(target), label: "临时目录", recursive: true }];
  if (text.includes("工作") || lower.includes("work")) {
    const workspace = target.account.config.workspace;
    if (workspace) {
      const resolved = workspace.startsWith("~") ? join(homedir(), workspace.slice(1)) : workspace;
      return [{ path: resolved, label: "工作目录", recursive: true }];
    }
  }

  // 没有明确指定目录时，搜索多个常见目录
  const dirs: { path: string; label: string; recursive?: boolean }[] = [];

  // 1. 配置的 searchPaths
  const configPaths = target.account.config.media?.searchPaths;
  if (configPaths && Array.isArray(configPaths)) {
    for (const p of configPaths) {
      const resolved = p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
      dirs.push({ path: resolved, label: basename(resolved) || p, recursive: true });
    }
  }

  // 2. 默认搜索目录（如果没有配置 searchPaths）
  if (dirs.length === 0) {
    dirs.push({ path: join(homedir(), "Desktop"), label: "桌面", recursive: true });
    dirs.push({ path: join(homedir(), "Downloads"), label: "下载", recursive: true });
    dirs.push({ path: join(homedir(), "Documents"), label: "文档", recursive: false }); // 文档目录默认不递归（可能很大）
    dirs.push({ path: resolveMediaTempDir(target), label: "临时目录", recursive: true });
  }

  return dirs;
}

/** 递归读取目录中的文件（带深度限制） */
async function readdirRecursive(
  dir: string,
  maxDepth: number = 3,
  currentDepth: number = 0
): Promise<{ name: string; path: string; relativePath: string }[]> {
  const results: { name: string; path: string; relativePath: string }[] = [];
  if (currentDepth > maxDepth) return results;

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      // 跳过隐藏文件和常见的忽略目录
      if (entry.name.startsWith(".")) continue;
      if (["node_modules", "__pycache__", ".git", ".svn", "vendor"].includes(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isFile()) {
        results.push({
          name: entry.name,
          path: fullPath,
          relativePath: entry.name,
        });
      } else if (entry.isDirectory() && currentDepth < maxDepth) {
        const subResults = await readdirRecursive(fullPath, maxDepth, currentDepth + 1);
        for (const sub of subResults) {
          results.push({
            name: sub.name,
            path: sub.path,
            relativePath: join(entry.name, sub.relativePath),
          });
        }
      }
    }
  } catch {
    // ignore directory read errors
  }
  return results;
}

/** 模糊匹配文件名 */
function fuzzyMatchFile(
  filename: string,
  keywords: string[],
  exactNames: string[]
): { score: number; matchType: "exact" | "fuzzy" | "none" } {
  const lowerFilename = filename.toLowerCase();
  const nameWithoutExt = lowerFilename.replace(/\.[^.]+$/, "");

  // 精确匹配（完整文件名）
  for (const exact of exactNames) {
    if (lowerFilename === exact.toLowerCase()) {
      return { score: 100, matchType: "exact" };
    }
  }

  // 关键词匹配
  let matchedKeywords = 0;
  let totalScore = 0;
  for (const keyword of keywords) {
    const lowerKeyword = keyword.toLowerCase();
    if (lowerFilename.includes(lowerKeyword) || nameWithoutExt.includes(lowerKeyword)) {
      matchedKeywords++;
      // 关键词越长，匹配分数越高
      totalScore += Math.min(keyword.length * 10, 50);
    }
  }

  if (matchedKeywords > 0) {
    // 匹配的关键词越多，分数越高
    totalScore += matchedKeywords * 20;
    return { score: Math.min(totalScore, 90), matchType: "fuzzy" };
  }

  return { score: 0, matchType: "none" };
}

function parseSelection(text: string, items: { name: string; path: string }[]): { name: string; path: string }[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/全部|都要|全都|都给我/.test(trimmed)) return items;
  const picked: { name: string; path: string }[] = [];
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

function buildPendingListText(pending: PendingSendList): { text: string; hasMore: boolean } {
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

async function tryHandleNaturalFileSend(params: {
  target: WecomWebhookTarget;
  text: string;
  fromUser: string;
  chatId?: string;
  isGroup: boolean;
}): Promise<boolean> {
  const { target, text, fromUser, chatId, isGroup } = params;
  if (!text || text.trim().startsWith("/")) return false;
  prunePendingLists();
  const key = pendingKey(target.account.accountId, fromUser, chatId);
  const pending = pendingSendLists.get(key);
  if (pending) {
    if (LIST_MORE_PATTERN.test(text)) {
      const nextOffset = pending.offset + MAX_LIST_PREVIEW;
      if (nextOffset >= pending.items.length) {
        await sendWecomText({
          account: target.account,
          toUser: fromUser,
          chatId: isGroup ? chatId : undefined,
          text: "已经是最后一页了。",
        });
        return true;
      }
      pending.offset = nextOffset;
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
      pendingSendLists.delete(key);
      await sendFilesByPath({ target, fromUser, chatId, isGroup, items: selection });
      return true;
    }
  }

  if (!/(发给我|发送给我|发我|给我)/.test(text)) return false;
  const exactNames = extractFilenameCandidates(text);
  const keywords = extractSearchKeywords(text);
  const ext = extractExtension(text);

  // 如果没有任何搜索条件，返回
  if (exactNames.length === 0 && keywords.length === 0 && !ext) return false;

  // 搜索多个目录（支持递归）
  const searchDirs = resolveSearchDirs(text, target);
  const allEntries: Map<string, { name: string; path: string; dir: string; score: number }> = new Map();

  for (const searchDir of searchDirs) {
    try {
      const maxDepth = searchDir.recursive ? 3 : 0;
      const entries = await readdirRecursive(searchDir.path, maxDepth);
      for (const entry of entries) {
        const { score, matchType } = fuzzyMatchFile(entry.name, keywords, exactNames);
        // 只保留有匹配的文件，或者按扩展名搜索时匹配扩展名的文件
        const matchesExt = ext && entry.name.toLowerCase().endsWith(`.${ext}`);
        if (score > 0 || matchesExt) {
          const finalScore = matchesExt ? Math.max(score, 50) : score;
          const existing = allEntries.get(entry.path);
          if (!existing || existing.score < finalScore) {
            allEntries.set(entry.path, {
              name: entry.relativePath,
              path: entry.path,
              dir: searchDir.label,
              score: finalScore,
            });
          }
        }
      }
    } catch {
      // ignore directory read errors
    }
  }

  // 按匹配分数排序
  const sortedEntries = Array.from(allEntries.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 100); // 最多返回100个结果

  const resolved: { name: string; path: string }[] = [];
  let foundInDir = "";

  // 如果有精确文件名，优先处理绝对路径
  for (const name of exactNames) {
    if (name.startsWith("/")) {
      try {
        const info = await stat(name);
        if (info.isFile()) {
          resolved.push({ name: basename(name), path: name });
        }
      } catch {
        // ignore
      }
    }
  }

  // 添加模糊匹配的结果
  for (const entry of sortedEntries) {
    if (!resolved.some(r => r.path === entry.path)) {
      resolved.push({ name: entry.name, path: entry.path });
      if (!foundInDir) foundInDir = entry.dir;
    }
  }

  if (resolved.length === 0) {
    // 没有找到匹配的文件，列出搜索目录中的一些文件作为提示
    const sampleFiles: string[] = [];
    for (const searchDir of searchDirs) {
      try {
        const entries = await readdir(searchDir.path);
        for (const entry of entries.slice(0, 3)) {
          if (!entry.startsWith(".")) sampleFiles.push(entry);
        }
        if (sampleFiles.length >= 5) break;
      } catch {
        // ignore
      }
    }
    const hint = sampleFiles.length ? `可用文件示例：${sampleFiles.join(", ")}` : "搜索目录中无可用文件";
    const searchedDirs = searchDirs.map(d => d.label).join("、");
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

  pendingSendLists.set(key, {
    items: resolved,
    dirLabel: foundInDir || searchDirs[0]?.label || "搜索结果",
    offset: 0,
    createdAt: Date.now(),
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
  const { text: listText } = buildPendingListText(pendingSendLists.get(key)!);
  await sendWecomText({
    account: target.account,
    toUser: fromUser,
    chatId: isGroup ? chatId : undefined,
    text: listText,
  });
  return true;
}

async function sendFilesByPath(params: {
  target: WecomWebhookTarget;
  fromUser: string;
  chatId?: string;
  isGroup: boolean;
  items: { name: string; path: string }[];
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
        error: String(err),
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

function logVerbose(target: WecomWebhookTarget, message: string): void {
  target.runtime.log?.(`[wecom] ${message}`);
}

function isTextCommand(text: string): boolean {
  return text.trim().startsWith("/");
}

// 本地缓存包装函数
async function getLocalCachedMedia(
  key: string | null,
  retentionMs?: number,
): Promise<MediaCacheEntry | null> {
  return getCachedMedia(mediaCache, key, retentionMs);
}

function storeLocalCachedMedia(key: string | null, entry: MediaCacheEntry): void {
  storeCachedMedia(mediaCache, key, entry, MEDIA_CACHE_MAX_ENTRIES);
}

async function startAgentForApp(params: {
  target: WecomWebhookTarget;
  fromUser: string;
  chatId?: string;
  isGroup: boolean;
  messageText: string;
  media?: {
    type: "image" | "voice" | "video" | "file";
    path: string;
    mimeType?: string;
    url?: string;
  } | null;
}): Promise<void> {
  const { target, fromUser, chatId, isGroup, messageText, media } = params;
  const account = target.account;

  const { core, route, storePath, ctxPayload, tableMode } = buildAgentContext({
    target,
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
      target.runtime.error?.(`wecom: failed updating session meta: ${String(err)}`);
    },
  });

  (core.channel as any)?.activity?.record?.({
    channel: "wecom",
    accountId: account.accountId,
    direction: "inbound",
  });

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
            maxBytes: resolveMediaMaxBytes(target),
          });
          if (result.sent) {
            logVerbose(target, `app ${result.type} reply delivered (${info.kind}) to ${fromUser}`);
            target.statusSink?.({ lastOutboundAt: Date.now() });
          }
        } catch (err) {
          target.runtime.error?.(`wecom app media reply failed: ${String(err)}`);
        }

        const text = markdownToWecomText(core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode));
        if (!text) return;
        await sendWecomText({ account, toUser: fromUser, chatId: isGroup ? chatId : undefined, text });
        (core.channel as any)?.activity?.record?.({
          channel: "wecom",
          accountId: account.accountId,
          direction: "outbound",
        });
        target.statusSink?.({ lastOutboundAt: Date.now() });
        logVerbose(target, `app reply delivered (${info.kind}) to ${fromUser}`);
      },
      onError: (err, info) => {
        target.runtime.error?.(`[${account.accountId}] wecom app ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      disableBlockStreaming: true,
    },
  });
}

async function processAppMessage(params: {
  target: WecomWebhookTarget;
  decryptedXml: string;
  msgObj: Record<string, any>;
}): Promise<void> {
  const { target, msgObj } = params;
  const msgType = String(msgObj?.MsgType ?? "").toLowerCase();
  const fromUser = String(msgObj?.FromUserName ?? "");
  const chatId = msgObj?.ChatId ? String(msgObj.ChatId) : "";
  const isGroup = Boolean(chatId);
  const summary = msgObj?.Content ? String(msgObj.Content).slice(0, 120) : "";
  logVerbose(target, `app inbound: MsgType=${msgType} From=${fromUser} ChatId=${chatId || "N/A"} Content=${summary}`);

  if (!fromUser) return;

  let messageText = "";
  let mediaContext: { type: "image" | "voice" | "video" | "file"; path: string; mimeType?: string; url?: string } | null = null;

  if (msgType === "text") {
    messageText = String(msgObj?.Content ?? "");
  }

  if (msgType === "voice") {
    const recognition = String(msgObj?.Recognition ?? "").trim();
    if (recognition) {
      messageText = `[语音消息转写] ${recognition}`;
    } else {
      const mediaId = String(msgObj?.MediaId ?? "");
      if (mediaId) {
        const result = await processInboundMedia({
          target, msgtype: "voice", mediaId,
          getCache: getLocalCachedMedia, storeCache: storeLocalCachedMedia,
        });
        messageText = result.text;
        if (result.media) mediaContext = { type: "voice", path: result.media.path, mimeType: result.media.mimeType, url: result.media.url };
      } else {
        messageText = "[用户发送了一条语音消息]\n\n请告诉用户语音处理暂时不可用。";
      }
    }
  }

  if (msgType === "image") {
    const mediaId = String(msgObj?.MediaId ?? "");
    const picUrl = String(msgObj?.PicUrl ?? "");
    const result = await processInboundMedia({
      target, msgtype: "image", mediaId: mediaId || undefined, url: picUrl || undefined,
      getCache: getLocalCachedMedia, storeCache: storeLocalCachedMedia,
    });
    messageText = result.text;
    if (result.media) mediaContext = { type: "image", path: result.media.path, mimeType: result.media.mimeType, url: result.media.url };
  }

  if (msgType === "link") {
    const title = String(msgObj?.Title ?? "(无标题)");
    const desc = String(msgObj?.Description ?? "(无描述)");
    const url = String(msgObj?.Url ?? "(无链接)");
    messageText = `[用户分享了一个链接]\n标题: ${title}\n描述: ${desc}\n链接: ${url}\n\n请根据链接内容回复用户。`;
  }

  if (msgType === "video") {
    const mediaId = String(msgObj?.MediaId ?? "");
    if (mediaId) {
      const result = await processInboundMedia({
        target, msgtype: "video", mediaId,
        getCache: getLocalCachedMedia, storeCache: storeLocalCachedMedia,
      });
      messageText = result.text;
      if (result.media) mediaContext = { type: "video", path: result.media.path, mimeType: result.media.mimeType, url: result.media.url };
    }
  }

  if (msgType === "file") {
    const mediaId = String(msgObj?.MediaId ?? "");
    const fileName = String(msgObj?.FileName ?? "");
    if (mediaId) {
      const result = await processInboundMedia({
        target, msgtype: "file", mediaId, filename: fileName || undefined,
        getCache: getLocalCachedMedia, storeCache: storeLocalCachedMedia,
      });
      messageText = result.text;
      if (result.media) mediaContext = { type: "file", path: result.media.path, mimeType: result.media.mimeType, url: result.media.url };
    }
  }

  if (!messageText) {
    return;
  }

  if (msgType === "text" && isTextCommand(messageText)) {
    const handled = await handleCommand(messageText, {
      account: target.account,
      fromUser,
      chatId,
      isGroup,
      cfg: target.config,
      log: target.runtime.log,
      statusSink: target.statusSink,
    });
    if (handled) return;
  }

  if (msgType === "text") {
    const handled = await tryHandleNaturalFileSend({
      target,
      text: messageText,
      fromUser,
      chatId,
      isGroup,
    });
    if (handled) return;
  }

  try {
    await startAgentForApp({
      target,
      fromUser,
      chatId,
      isGroup,
      messageText,
      media: mediaContext,
    });
  } catch (err) {
    target.runtime.error?.(`wecom app agent failed: ${String(err)}`);
    try {
      await sendWecomText({
        account: target.account,
        toUser: fromUser,
        chatId: isGroup ? chatId : undefined,
        text: "抱歉，处理您的消息时出现错误，请稍后重试。",
      });
    } catch {
      // ignore
    }
  }
}

type PushMessage = {
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

type PushPayload = PushMessage & {
  accountId?: string;
  toUser?: string;
  chatId?: string;
  token?: string;
  intervalMs?: number;
  messages?: PushMessage[];
};

function resolvePushToken(target: WecomWebhookTarget): string {
  return target.account.config.pushToken?.trim() || "";
}

function selectPushTarget(targets: WecomWebhookTarget[], accountId?: string): WecomWebhookTarget | undefined {
  const appTargets = targets.filter((candidate) => shouldHandleApp(candidate));
  if (!accountId) return appTargets[0];
  return appTargets.find((candidate) => candidate.account.accountId === accountId);
}

export async function handleWecomPushRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  targets: WecomWebhookTarget[];
}): Promise<boolean> {
  const { req, res, targets } = params;
  if ((req.method ?? "").toUpperCase() !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  let payload: PushPayload | null = null;
  try {
    const raw = await readRequestBody(req, MAX_REQUEST_BODY_SIZE);
    payload = raw ? (JSON.parse(raw) as PushPayload) : {};
  } catch (err) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: `Invalid JSON: ${String(err)}` }));
    return true;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const accountId = pickString(payload?.accountId, url.searchParams.get("accountId"));
  const target = selectPushTarget(targets, accountId);
  if (!target) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "No matching WeCom app account" }));
    return true;
  }

  const expectedToken = resolvePushToken(target);
  if (!expectedToken) {
    target.runtime.error?.("[wecom] push endpoint rejected: pushToken not configured. Set pushToken in account config to enable push.");
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Push token not configured" }));
    return true;
  }
  const requestToken = pickString(
    payload?.token,
    url.searchParams.get("token"),
    resolveHeaderToken(req),
  );
  // 使用时序安全比较，防止 timing attack
  const tokenMatch = (() => {
    if (!expectedToken || !requestToken) return false;
    const a = Buffer.from(expectedToken, "utf8");
    const b = Buffer.from(requestToken, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  })();
  if (!tokenMatch) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Invalid push token" }));
    return true;
  }

  const toUser = pickString(payload?.toUser, url.searchParams.get("toUser"));
  const chatId = pickString(payload?.chatId, url.searchParams.get("chatId"));
  if (!toUser && !chatId) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Missing toUser or chatId" }));
    return true;
  }

  if (!target.account.corpId || !target.account.corpSecret || !target.account.agentId) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "WeCom app not configured" }));
    return true;
  }

  const MAX_DELAY_MS = 60_000;
  const messages = Array.isArray(payload?.messages) && payload?.messages.length > 0
    ? payload.messages
    : [payload ?? {}];
  const intervalMs = typeof payload?.intervalMs === "number" && payload.intervalMs > 0
    ? Math.min(payload.intervalMs, MAX_DELAY_MS) : 0;
  let sent = 0;

  for (const message of messages) {
    if (message.delayMs && message.delayMs > 0) {
      await sleep(Math.min(message.delayMs, MAX_DELAY_MS));
    }
    try {
      const result = await dispatchOutboundMedia({
        payload: message,
        account: target.account,
        toUser,
        chatId: chatId || undefined,
        maxBytes: resolveMediaMaxBytes(target),
        title: message.title,
        description: message.description,
      });
      if (result.sent) {
        await appendOperationLog(target.account.config.operations?.logPath, {
          action: "push-media",
          accountId: target.account.accountId,
          toUser,
          chatId: chatId || undefined,
          mediaType: result.type,
        });
        sent += 1;
      }

      const text = markdownToWecomText(message.text ?? "");
      if (text) {
        await sendWecomText({ account: target.account, toUser, chatId: chatId || undefined, text });
        await appendOperationLog(target.account.config.operations?.logPath, {
          action: "push-text",
          accountId: target.account.accountId,
          toUser,
          chatId: chatId || undefined,
          textPreview: text.slice(0, 120),
        });
        sent += 1;
      }
    } catch (err) {
      target.runtime.error?.(`wecom push failed: ${String(err)}`);
    }

    if (intervalMs) {
      await sleep(intervalMs);
    }
  }

  target.statusSink?.({ lastOutboundAt: Date.now() });
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: true, sent }));
  return true;
}

export async function handleWecomAppWebhook(params: {
  req: IncomingMessage;
  res: ServerResponse;
  targets: WecomWebhookTarget[];
  rawBody?: string;
}): Promise<boolean> {
  const { req, res, targets, rawBody } = params;
  const query = resolveQueryParams(req);
  const timestamp = query.get("timestamp") ?? "";
  const nonce = query.get("nonce") ?? "";
  const signature = resolveSignatureParam(query);

  if (req.method === "GET") {
    const echostr = query.get("echostr") ?? "";
    if (!timestamp || !nonce || !signature || !echostr) {
      return false;
    }

    const target = targets.find((candidate) => {
      if (!shouldHandleApp(candidate)) return false;
      const token = candidate.account.callbackToken ?? "";
      const aesKey = candidate.account.callbackAesKey ?? "";
      if (!token || !aesKey) return false;
      return verifyWecomSignature({
        token,
        timestamp,
        nonce,
        encrypt: echostr,
        signature,
      });
    });

    if (!target || !target.account.callbackAesKey) {
      return false;
    }

    try {
      const plain = decryptWecomEncrypted({
        encodingAESKey: target.account.callbackAesKey,
        receiveId: target.account.corpId ?? "",
        encrypt: echostr,
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(plain);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.statusCode = 400;
      res.end(msg || "decrypt failed");
      return true;
    }
  }

  if (req.method !== "POST") {
    return false;
  }

  if (!timestamp || !nonce || !signature) {
    return false;
  }

  let rawXml = "";
  if (rawBody != null) {
    rawXml = rawBody;
  } else {
    try {
      rawXml = await readRequestBody(req, MAX_REQUEST_BODY_SIZE);
    } catch {
      res.statusCode = 413;
      res.end("payload too large");
      return true;
    }
  }

  if (!rawXml.trim().startsWith("<")) {
    return false;
  }

  let incoming: Record<string, any>;
  try {
    incoming = parseIncomingXml(rawXml);
  } catch {
    return false;
  }

  const encrypt = String(incoming?.Encrypt ?? "");
  if (!encrypt) {
    res.statusCode = 400;
    res.end("Missing Encrypt");
    return true;
  }

  const target = targets.find((candidate) => {
    if (!shouldHandleApp(candidate)) return false;
    const token = candidate.account.callbackToken ?? "";
    const aesKey = candidate.account.callbackAesKey ?? "";
    if (!token || !aesKey) return false;
    return verifyWecomSignature({
      token,
      timestamp,
      nonce,
      encrypt,
      signature,
    });
  });

  if (!target) {
    return false;
  }

  if (!target.account.callbackAesKey || !target.account.callbackToken) {
    res.statusCode = 500;
    res.end("wecom app not configured");
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("success");

  let decryptedXml = "";
  try {
    decryptedXml = decryptWecomEncrypted({
      encodingAESKey: target.account.callbackAesKey,
      receiveId: target.account.corpId ?? "",
      encrypt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    target.runtime.error?.(`wecom app decrypt failed: ${msg}`);
    return true;
  }

  let msgObj: Record<string, any> = {};
  try {
    msgObj = parseIncomingXml(decryptedXml);
  } catch (err) {
    target.runtime.error?.(`wecom app parse xml failed: ${String(err)}`);
    return true;
  }

  target.statusSink?.({ lastInboundAt: Date.now() });

  processAppMessage({ target, decryptedXml, msgObj }).catch((err) => {
    target.runtime.error?.(`wecom app async processing failed: ${String(err)}`);
  });

  return true;
}
