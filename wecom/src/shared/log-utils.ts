import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { WecomAccountConfig } from "../types.js";

/**
 * 追加操作日志
 */
export async function appendOperationLog(
  logPath: string | undefined,
  entry: Record<string, unknown>,
): Promise<void> {
  const path = logPath?.trim();
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // ignore logging failures
  }
}

/**
 * 解析发送间隔时间
 */
export function resolveSendIntervalMs(config: WecomAccountConfig): number {
  const interval = config.sendQueue?.intervalMs;
  return typeof interval === "number" && interval >= 0 ? interval : 400;
}
