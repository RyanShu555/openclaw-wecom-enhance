import type { IncomingMessage, ServerResponse } from "node:http";

import type { PluginRuntime } from "openclaw/plugin-sdk";

import type { WecomWebhookTarget } from "./monitor.js";
import type { WecomInboundMessage } from "./types.js";
import { getWecomRuntime } from "./runtime.js";
import {
  formatErrorDetail,
} from "./shared/string-utils.js";
import { ConversationQueue, type PendingBatch } from "./shared/conversation-queue.js";
import {
  pruneBotState,
  streams,
} from "./bot/state.js";
import { handleWecomBotWebhookCore } from "./bot/webhook-handler.js";
import { startAgentForStream as startAgentForStreamImpl } from "./bot/stream-agent.js";
import type { BotBatchMeta } from "./bot/contracts.js";

// ── 会话级防抖队列 ──
const botQueue = new ConversationQueue<BotBatchMeta>();
botQueue.setFlushHandler((batch) => void flushBotBatch(batch));

async function flushBotBatch(batch: PendingBatch<BotBatchMeta>): Promise<void> {
  const { meta } = batch;
  const { target, streamId } = meta;
  // 聚合多条消息为一条
  const mergedText = batch.contents.join("\n");
  const mergedMsg: WecomInboundMessage = {
    ...meta.msg,
    msgtype: "text",
    text: { content: mergedText },
  };
  try {
    let core: PluginRuntime | null = null;
    try { core = getWecomRuntime(); } catch { /* runtime not ready */ }
    if (core) {
      const streamState = streams.get(streamId);
      if (streamState) streamState.started = true;
      await startAgentForStream({ target, msg: mergedMsg, streamId });
    } else {
      const state = streams.get(streamId);
      if (state) {
        const now = Date.now();
        state.finished = true;
        state.finishedAt = now;
        state.updatedAt = now;
      }
    }
  } catch (err) {
    const state = streams.get(streamId);
    if (state) {
      const now = Date.now();
      state.error = err instanceof Error ? err.message : String(err);
      state.content = state.content || `Error: ${state.error}`;
      state.finished = true;
      state.finishedAt = now;
      state.updatedAt = now;
    }
    target.runtime.error?.(`[${target.account.accountId}] wecom agent failed: ${formatErrorDetail(err)}`);
  } finally {
    botQueue.onBatchFinished(batch.conversationKey);
  }
}

// 定时兜底清理，避免低流量时过期条目长期驻留
setInterval(() => pruneBotState(botQueue), 5 * 60 * 1000).unref();

function logVerbose(target: WecomWebhookTarget, message: string): void {
  try {
    const core = getWecomRuntime();
    const should = core.logging?.shouldLogVerbose?.() ?? false;
    if (should) {
      target.runtime.log?.(`[wecom] ${message}`);
    }
  } catch {
    // runtime not ready; skip verbose logging
  }
}

async function startAgentForStream(params: {
  target: WecomWebhookTarget;
  msg: WecomInboundMessage;
  streamId: string;
}): Promise<void> {
  return startAgentForStreamImpl({
    ...params,
    logVerbose,
  });
}

export async function handleWecomBotWebhook(params: {
  req: IncomingMessage;
  res: ServerResponse;
  targets: WecomWebhookTarget[];
  rawBody?: string;
}): Promise<boolean> {
  pruneBotState(botQueue);
  return handleWecomBotWebhookCore({
    ...params,
    botQueue,
    startAgentForStream,
    logVerbose,
  });
}
