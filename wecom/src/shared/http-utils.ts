import type { IncomingMessage } from "node:http";

/**
 * 安全解码 URI 组件，解码失败时返回原值
 */
export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 从请求中解析查询参数
 */
export function resolveQueryParams(req: IncomingMessage): URLSearchParams {
  const rawUrl = req.url ?? "";
  const queryIndex = rawUrl.indexOf("?");
  if (queryIndex < 0) return new URLSearchParams();
  const queryString = rawUrl.slice(queryIndex + 1);
  const params = new URLSearchParams();
  if (!queryString) return params;
  for (const part of queryString.split("&")) {
    if (!part) continue;
    const eqIndex = part.indexOf("=");
    const keyRaw = eqIndex >= 0 ? part.slice(0, eqIndex) : part;
    const valueRaw = eqIndex >= 0 ? part.slice(eqIndex + 1) : "";
    const key = safeDecodeURIComponent(keyRaw);
    const value = safeDecodeURIComponent(valueRaw);
    params.append(key, value);
  }
  return params;
}

/**
 * 从查询参数中解析签名（支持多种参数名）
 */
export function resolveSignatureParam(params: URLSearchParams): string {
  return (
    params.get("msg_signature") ??
    params.get("msgsignature") ??
    params.get("signature") ??
    ""
  );
}

/**
 * 从请求头中解析 Token
 */
export function resolveHeaderToken(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? "";
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const token = req.headers["x-openclaw-token"];
  if (typeof token === "string") return token.trim();
  return "";
}

/**
 * 读取请求体
 */
export async function readRequestBody(req: IncomingMessage, maxSize: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on("data", (c) => {
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        reject(new Error(`Request body too large (limit: ${maxSize} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * 读取 JSON 请求体
 */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        resolve({ ok: true, value: JSON.parse(raw) as unknown });
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

/**
 * 返回 JSON 响应
 */
export function jsonOk(res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (s: string) => void }, body: unknown): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
