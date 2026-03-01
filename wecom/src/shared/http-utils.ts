import type { IncomingMessage } from "node:http";

/**
 * 从请求中解析查询参数
 */
export function resolveQueryParams(req: IncomingMessage): URLSearchParams {
  const rawUrl = req.url ?? "";
  const idx = rawUrl.indexOf("?");
  return idx < 0 ? new URLSearchParams() : new URLSearchParams(rawUrl.slice(idx + 1));
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
    let done = false;

    req.on("data", (c) => {
      if (done) return;
      const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        done = true;
        reject(new Error(`Request body too large (limit: ${maxSize} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
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
