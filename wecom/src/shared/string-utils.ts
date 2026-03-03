/**
 * 从多个值中选取第一个非空字符串
 */
export function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * 安全解析正数配置值，无效时返回默认值
 */
export function num(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback;
}

/**
 * 安全解析正数配置值，无效时返回 undefined
 */
export function numOpt(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

/**
 * 延迟指定毫秒数
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 截断文本到指定长度
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/**
 * 截断 UTF-8 字节到指定长度
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Walk back to a valid UTF-8 character boundary
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}

/**
 * 从 Error / unknown 中提取可读的诊断信息（含 stack、WecomApiError 字段等）。
 * 用于 runtime.error / 日志，取代裸 `String(err)`。
 */
export function formatErrorDetail(err: unknown): string {
  if (err instanceof WecomApiError) {
    const parts = [
      `errcode=${err.errcode}`,
      `errmsg=${err.errmsg}`,
    ];
    if (err.apiUrl) parts.push(`url=${err.apiUrl}`);
    if (err.httpStatus) parts.push(`status=${err.httpStatus}`);
    if (err.accountId) parts.push(`account=${err.accountId}`);
    const detail = parts.join(", ");
    return err.stack ? `${detail}\n${err.stack}` : detail;
  }
  if (err instanceof Error) {
    return err.stack || err.message;
  }
  return String(err);
}

// ── WeChat Work API 错误 ──

/** 是否为 access_token 过期/无效等可通过刷新 token 恢复的错误 */
const TOKEN_EXPIRED_CODES = new Set([40001, 40014, 42001]);

/** 不可恢复的配置 / 权限类错误，重试无意义 */
const PERMANENT_ERROR_CODES = new Set([60020, 60011, 60012, 60102]);

export class WecomApiError extends Error {
  readonly errcode: number;
  readonly errmsg: string;
  readonly apiUrl?: string;
  readonly httpStatus?: number;
  readonly accountId?: string;

  constructor(params: {
    errcode: number;
    errmsg: string;
    apiUrl?: string;
    httpStatus?: number;
    accountId?: string;
  }) {
    const hint = params.errcode === 60020
      ? " [action: 请在企业微信管理后台「应用管理→自建应用→企业可信IP」中添加服务器出口 IP]"
      : "";
    super(`WeCom API error: errcode=${params.errcode}, errmsg=${params.errmsg}${hint}`);
    this.name = "WecomApiError";
    this.errcode = params.errcode;
    this.errmsg = params.errmsg;
    this.apiUrl = params.apiUrl;
    this.httpStatus = params.httpStatus;
    this.accountId = params.accountId;
  }

  get isTokenExpired(): boolean {
    return TOKEN_EXPIRED_CODES.has(this.errcode);
  }

  get isPermanent(): boolean {
    return PERMANENT_ERROR_CODES.has(this.errcode);
  }
}
