import { splitWecomText } from "./format.js";
import type { ResolvedWecomAccount } from "./types.js";
import { sleep, num, WecomApiError } from "./shared/string-utils.js";
import { MEDIA_TOO_LARGE_ERROR } from "./shared/media-shared.js";

// ── 出站代理支持 ──
let cachedProxyModule: typeof import("undici") | null | false = null;
const proxyDispatchers = new Map<string, any>();

async function getProxyDispatcher(proxyUrl: string): Promise<any | undefined> {
  if (!proxyUrl) return undefined;
  const cached = proxyDispatchers.get(proxyUrl);
  if (cached) return cached;

  // 动态加载 undici（可选依赖）
  if (cachedProxyModule === false) return undefined;
  if (cachedProxyModule === null) {
    try {
      cachedProxyModule = await import("undici");
    } catch {
      cachedProxyModule = false;
      return undefined;
    }
  }
  const { ProxyAgent } = cachedProxyModule;
  const dispatcher = new ProxyAgent(proxyUrl);
  proxyDispatchers.set(proxyUrl, dispatcher);
  return dispatcher;
}

function resolveEgressProxyUrl(account: ResolvedWecomAccount): string {
  return account.config.network?.egressProxyUrl?.trim() || "";
}

export type WecomTokenState = {
  token: string | null;
  expiresAt: number;
  refreshPromise: Promise<string> | null;
};

type WecomRecipients = {
  toUser?: string;
  chatId?: string;
  toParty?: string | string[];
  toTag?: string | string[];
};

class RateLimiter {
  private maxConcurrent: number;
  private minInterval: number;
  private running: number;
  private queue: Array<{ fn: () => Promise<any>; resolve: (v: any) => void; reject: (e: any) => void }>;
  private lastExecution: number;

  constructor({ maxConcurrent = 3, minInterval = 200 } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.minInterval = minInterval;
    this.running = 0;
    this.queue = [];
    this.lastExecution = 0;
  }

  execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const now = Date.now();
    const waitTime = Math.max(0, this.lastExecution + this.minInterval - now);

    if (waitTime > 0) {
      setTimeout(() => this.processQueue(), waitTime);
      return;
    }

    this.running += 1;
    this.lastExecution = Date.now();

    const { fn, resolve, reject } = this.queue.shift()!;

    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this.running -= 1;
      this.processQueue();
    }
  }
}

const accessTokenCaches = new Map<string, WecomTokenState>();
const apiLimiter = new RateLimiter({ maxConcurrent: 3, minInterval: 200 });

function ensureAppConfig(account: ResolvedWecomAccount): { corpId: string; corpSecret: string; agentId: number } {
  const corpId = account.corpId ?? "";
  const corpSecret = account.corpSecret ?? "";
  const agentId = account.agentId ?? 0;
  if (!corpId || !corpSecret || !agentId) {
    throw new Error("WeCom app not configured (corpId/corpSecret/agentId required)");
  }
  return { corpId, corpSecret, agentId };
}

function normalizeRecipientField(value?: string | string[]): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .join("|");
  }
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw
    .split(/[\s,|]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .join("|");
}

function resolveNormalizedRecipients(params: WecomRecipients): {
  toUser: string;
  chatId: string;
  toParty: string;
  toTag: string;
} {
  return {
    toUser: normalizeRecipientField(params.toUser),
    chatId: String(params.chatId ?? "").trim(),
    toParty: normalizeRecipientField(params.toParty),
    toTag: normalizeRecipientField(params.toTag),
  };
}

function hasAnyRecipient(recipient: {
  toUser: string;
  chatId: string;
  toParty: string;
  toTag: string;
}): boolean {
  return Boolean(recipient.chatId || recipient.toUser || recipient.toParty || recipient.toTag);
}

/** 使指定 account 的 token 缓存失效，下次调用会重新获取 */
function invalidateToken(account: ResolvedWecomAccount): void {
  const corpId = account.corpId ?? "";
  const agentId = account.agentId ?? 0;
  const cacheKey = `${corpId}:${agentId}`;
  accessTokenCaches.delete(cacheKey);
}

function resolveNetworkConfig(account: ResolvedWecomAccount): { timeoutMs: number; retries: number; retryDelayMs: number } {
  const cfg = account.config.network ?? {};
  return {
    timeoutMs: num(cfg.timeoutMs, 15000),
    retries: typeof cfg.retries === "number" && cfg.retries >= 0 ? cfg.retries : 2,
    retryDelayMs: typeof cfg.retryDelayMs === "number" && cfg.retryDelayMs >= 0 ? cfg.retryDelayMs : 300,
  };
}

async function fetchWithRetry(account: ResolvedWecomAccount, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { timeoutMs, retries, retryDelayMs } = resolveNetworkConfig(account);
  const proxyUrl = resolveEgressProxyUrl(account);
  const dispatcher = proxyUrl ? await getProxyDispatcher(proxyUrl) : undefined;
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const fetchInit = { ...init, signal: controller.signal } as any;
      if (dispatcher) fetchInit.dispatcher = dispatcher;
      const res = await apiLimiter.execute(() => fetch(input, fetchInit));
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt >= retries) break;
      await sleep(retryDelayMs * Math.max(1, attempt + 1));
    }
    attempt += 1;
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function resolveContentLength(res: Response): number | null {
  const raw = res.headers.get("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function ensureNotTooLarge(res: Response, maxBytes?: number): void {
  if (!maxBytes || maxBytes <= 0) return;
  const length = resolveContentLength(res);
  if (length && length > maxBytes) {
    const err = new Error(`${MEDIA_TOO_LARGE_ERROR}: content-length ${length} > limit ${maxBytes}`);
    (err as { code?: string }).code = MEDIA_TOO_LARGE_ERROR;
    throw err;
  }
}

export async function getWecomAccessToken(account: ResolvedWecomAccount): Promise<string> {
  const { corpId, corpSecret, agentId } = ensureAppConfig(account);
  const cacheKey = `${corpId}:${agentId}`;
  let cache = accessTokenCaches.get(cacheKey);

  if (!cache) {
    cache = { token: null, expiresAt: 0, refreshPromise: null };
    accessTokenCaches.set(cacheKey, cache);
  }

  const now = Date.now();
  if (cache.token && cache.expiresAt > now + 60000) {
    return cache.token;
  }

  if (cache.refreshPromise) {
    return cache.refreshPromise;
  }

  cache.refreshPromise = (async () => {
    try {
      const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(corpSecret)}`;
      const tokenRes = await fetchWithRetry(account, tokenUrl);
      const tokenJson = await tokenRes.json();
      if (!tokenJson?.access_token) {
        throw new WecomApiError({
          errcode: tokenJson?.errcode ?? -1,
          errmsg: tokenJson?.errmsg ?? "unknown (no access_token in response)",
          apiUrl: "gettoken",
          accountId: account.accountId,
        });
      }

      cache.token = tokenJson.access_token;
      cache.expiresAt = Date.now() + (tokenJson.expires_in || 7200) * 1000;

      return cache.token;
    } finally {
      cache.refreshPromise = null;
    }
  })();

  return cache.refreshPromise;
}

async function sendWecomTextSingle(params: {
  account: ResolvedWecomAccount;
  toUser?: string;
  chatId?: string;
  toParty?: string | string[];
  toTag?: string | string[];
  text: string;
}): Promise<void> {
  const { account, text } = params;
  const { agentId } = ensureAppConfig(account);
  const recipient = resolveNormalizedRecipients(params);
  if (!hasAnyRecipient(recipient)) {
    throw new Error("WeCom sendWecomText requires recipient (toUser/chatId/toParty/toTag).");
  }

  for (let tokenAttempt = 0; tokenAttempt < 2; tokenAttempt++) {
    const accessToken = await getWecomAccessToken(account);
    const useChat = Boolean(recipient.chatId);
    const sendUrl = useChat
      ? `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${encodeURIComponent(accessToken)}`
      : `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;

    const body = useChat
      ? { chatid: recipient.chatId, msgtype: "text", text: { content: text } }
      : {
        touser: recipient.toUser,
        toparty: recipient.toParty,
        totag: recipient.toTag,
        msgtype: "text",
        agentid: agentId,
        text: { content: text },
      };

    const sendRes = await fetchWithRetry(account, sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const sendJson = await sendRes.json();
    if (sendJson?.errcode === 0) return;

    const apiErr = new WecomApiError({
      errcode: sendJson?.errcode ?? -1,
      errmsg: sendJson?.errmsg ?? "unknown",
      apiUrl: useChat ? "appchat/send" : "message/send",
      accountId: account.accountId,
    });

    // token 过期：清缓存后重试一次
    if (apiErr.isTokenExpired && tokenAttempt === 0) {
      invalidateToken(account);
      continue;
    }
    throw apiErr;
  }
}

export async function sendWecomText(params: {
  account: ResolvedWecomAccount;
  toUser?: string;
  chatId?: string;
  toParty?: string | string[];
  toTag?: string | string[];
  text: string;
}): Promise<void> {
  const { account, text } = params;
  const chunks = splitWecomText(text);
  for (const chunk of chunks) {
    if (!chunk) continue;
    await sendWecomTextSingle({ ...params, account, text: chunk });
  }
}

export async function uploadWecomMedia(params: {
  account: ResolvedWecomAccount;
  type: "image" | "voice" | "video" | "file";
  buffer: Buffer;
  filename: string;
}): Promise<string> {
  const { account, type, buffer, filename } = params;

  for (let tokenAttempt = 0; tokenAttempt < 2; tokenAttempt++) {
    const accessToken = await getWecomAccessToken(account);
    const uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${encodeURIComponent(accessToken)}&type=${encodeURIComponent(type)}`;

    const form = new FormData();
    form.append("media", new Blob([buffer]), filename);

    const res = await fetchWithRetry(account, uploadUrl, {
      method: "POST",
      body: form,
    });
    const json = await res.json();
    if (json?.media_id) return json.media_id;

    const apiErr = new WecomApiError({
      errcode: json?.errcode ?? -1,
      errmsg: json?.errmsg ?? "unknown",
      apiUrl: "media/upload",
      accountId: account.accountId,
    });
    if (apiErr.isTokenExpired && tokenAttempt === 0) {
      invalidateToken(account);
      continue;
    }
    throw apiErr;
  }
  // unreachable, but TS needs a return
  throw new Error("uploadWecomMedia: unexpected flow");
}

export type MediaType = "image" | "voice" | "video" | "file";

/**
 * 通用媒体发送函数
 */
export async function sendWecomMedia(params: {
  account: ResolvedWecomAccount;
  toUser?: string;
  chatId?: string;
  toParty?: string | string[];
  toTag?: string | string[];
  mediaId: string;
  mediaType: MediaType;
  title?: string;
  description?: string;
}): Promise<void> {
  const { account, mediaId, mediaType, title, description } = params;
  const { agentId } = ensureAppConfig(account);
  const recipient = resolveNormalizedRecipients(params);
  if (!hasAnyRecipient(recipient)) {
    throw new Error("WeCom sendWecomMedia requires recipient (toUser/chatId/toParty/toTag).");
  }

  for (let tokenAttempt = 0; tokenAttempt < 2; tokenAttempt++) {
    const accessToken = await getWecomAccessToken(account);
    const useChat = Boolean(recipient.chatId);
    const sendUrl = useChat
      ? `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${encodeURIComponent(accessToken)}`
      : `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;

    const mediaPayload = mediaType === "video"
      ? { media_id: mediaId, title: title ?? "Video", description: description ?? "" }
      : { media_id: mediaId };

    const body = useChat
      ? { chatid: recipient.chatId, msgtype: mediaType, [mediaType]: mediaPayload }
      : {
        touser: recipient.toUser,
        toparty: recipient.toParty,
        totag: recipient.toTag,
        msgtype: mediaType,
        agentid: agentId,
        [mediaType]: mediaPayload,
      };

    const sendRes = await fetchWithRetry(account, sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const sendJson = await sendRes.json();
    if (sendJson?.errcode === 0) return;

    const apiErr = new WecomApiError({
      errcode: sendJson?.errcode ?? -1,
      errmsg: sendJson?.errmsg ?? "unknown",
      apiUrl: useChat ? "appchat/send" : "message/send",
      accountId: account.accountId,
    });
    if (apiErr.isTokenExpired && tokenAttempt === 0) {
      invalidateToken(account);
      continue;
    }
    throw apiErr;
  }
}

// 便捷方法：发送文件
export async function sendWecomFile(params: {
  account: ResolvedWecomAccount;
  toUser?: string;
  chatId?: string;
  toParty?: string | string[];
  toTag?: string | string[];
  mediaId: string;
}): Promise<void> {
  return sendWecomMedia({ ...params, mediaType: "file" });
}

export async function downloadWecomMedia(params: {
  account: ResolvedWecomAccount;
  mediaId: string;
  maxBytes?: number;
}): Promise<{ buffer: Buffer; contentType: string } > {
  const { account, mediaId, maxBytes } = params;
  const accessToken = await getWecomAccessToken(account);
  const mediaUrl = `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${encodeURIComponent(accessToken)}&media_id=${encodeURIComponent(mediaId)}`;

  const res = await fetchWithRetry(account, mediaUrl);
  if (!res.ok) {
    throw new Error(`Failed to download media: ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "";
  ensureNotTooLarge(res, maxBytes);
  if (contentType.includes("application/json")) {
    const json = await res.json();
    throw new WecomApiError({
      errcode: json?.errcode ?? -1,
      errmsg: json?.errmsg ?? "unknown",
      apiUrl: "media/get",
      accountId: account.accountId,
    });
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

export async function fetchMediaFromUrl(
  url: string,
  account?: ResolvedWecomAccount,
  maxBytes?: number,
): Promise<{ buffer: Buffer; contentType: string } > {
  const res = account ? await fetchWithRetry(account, url) : await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch media from URL: ${res.status}`);
  }
  ensureNotTooLarge(res, maxBytes);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  return { buffer, contentType };
}
