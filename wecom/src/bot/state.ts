import crypto from "node:crypto";

import { truncateUtf8Bytes } from "../shared/string-utils.js";

export const STREAM_TTL_MS = 10 * 60 * 1000;
export const STREAM_MAX_BYTES = 20_480;
export const STREAM_MAX_ENTRIES = 500;
export const DEDUPE_TTL_MS = 2 * 60 * 1000;
export const DEDUPE_MAX_ENTRIES = 2_000;

export type StreamState = {
  streamId: string;
  msgid?: string;
  responseUrl?: string;
  conversationKey?: string;
  userId?: string;
  chatType?: "group" | "direct";
  chatId?: string;
  createdAt: number;
  updatedAt: number;
  started: boolean;
  finished: boolean;
  finishedAt?: number;
  lastRefreshAt?: number;
  pushedViaResponseUrlAt?: number;
  error?: string;
  content: string;
  fallbackMode?: "media" | "timeout" | "error";
  dmContent?: string;
};

export type StreamReply = {
  msgtype: "stream";
  stream: {
    id: string;
    finish: boolean;
    content: string;
  };
};

type QueuePruner = {
  prune: (ttlMs: number) => void;
};

export const streams = new Map<string, StreamState>();
export const msgidToStreamId = new Map<string, string>();
export const recentEncrypts = new Map<string, { ts: number; streamId?: string }>();

export function pruneBotState(queue?: QueuePruner): void {
  const cutoff = Date.now() - STREAM_TTL_MS;
  for (const [id, state] of streams.entries()) {
    if (state.updatedAt < cutoff) {
      streams.delete(id);
    }
  }
  for (const [msgid, id] of msgidToStreamId.entries()) {
    if (!streams.has(id)) {
      msgidToStreamId.delete(msgid);
    }
  }

  const dedupeCutoff = Date.now() - DEDUPE_TTL_MS;
  for (const [hash, entry] of recentEncrypts.entries()) {
    if (entry.ts < dedupeCutoff) {
      recentEncrypts.delete(hash);
    }
  }

  if (streams.size > STREAM_MAX_ENTRIES) {
    const sorted = Array.from(streams.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const overflow = sorted.length - STREAM_MAX_ENTRIES;
    for (let i = 0; i < overflow; i += 1) {
      const [streamId] = sorted[i]!;
      streams.delete(streamId);
    }
  }

  if (recentEncrypts.size > DEDUPE_MAX_ENTRIES) {
    const sorted = Array.from(recentEncrypts.entries()).sort((a, b) => a[1].ts - b[1].ts);
    const overflow = sorted.length - DEDUPE_MAX_ENTRIES;
    for (let i = 0; i < overflow; i += 1) {
      recentEncrypts.delete(sorted[i]![0]);
    }
  }

  queue?.prune(STREAM_TTL_MS);
}

export function buildStreamPlaceholderReply(streamId: string): StreamReply {
  return {
    msgtype: "stream",
    stream: {
      id: streamId,
      finish: false,
      content: "\ud83e\udd14\u601d\u8003\u4e2d...",
    },
  };
}

export function buildStreamReplyFromState(state: StreamState): StreamReply {
  const content = truncateUtf8Bytes(state.content, STREAM_MAX_BYTES);
  return {
    msgtype: "stream",
    stream: {
      id: state.streamId,
      finish: state.finished,
      content,
    },
  };
}

export function createStreamId(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function hashEncryptPayload(encrypt: string): string {
  return crypto.createHash("sha256").update(encrypt).digest("hex");
}

export async function waitForStreamContent(streamId: string, maxWaitMs: number): Promise<void> {
  if (maxWaitMs <= 0) return;
  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const state = streams.get(streamId);
      if (!state) return resolve();
      if (state.error || state.finished || state.content.trim()) return resolve();
      if (Date.now() - startedAt >= maxWaitMs) return resolve();
      setTimeout(tick, 25);
    };
    tick();
  });
}
