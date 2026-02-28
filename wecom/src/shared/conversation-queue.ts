/**
 * 会话级消息防抖 + 队列
 *
 * 解决用户连发多条消息时触发多次独立 agent 调用的问题。
 * - 500ms 防抖窗口：快速连发的消息聚合为一批
 * - 会话级队列：每个会话同时只处理一批，后续排队
 */

export type PendingBatch<T = unknown> = {
  conversationKey: string;
  batchKey: string;
  contents: string[];
  meta: T;
  createdAt: number;
  timeout: ReturnType<typeof setTimeout> | null;
  readyToFlush: boolean;
};

type ConversationState = {
  activeBatchKey: string;
  queue: string[];
  nextSeq: number;
};

export const DEFAULT_DEBOUNCE_MS = 500;

export class ConversationQueue<T = unknown> {
  private pending = new Map<string, PendingBatch<T>>();
  private conversations = new Map<string, ConversationState>();
  private onFlush?: (batch: PendingBatch<T>) => void;

  constructor(private debounceMs: number = DEFAULT_DEBOUNCE_MS) {}

  setFlushHandler(handler: (batch: PendingBatch<T>) => void): void {
    this.onFlush = handler;
  }

  /**
   * 添加一条消息到会话队列。
   * 返回 batchKey 和状态（active_new / active_merged / queued_new / queued_merged）。
   */
  add(params: {
    conversationKey: string;
    content: string;
    meta: T;
  }): { batchKey: string; status: "active_new" | "active_merged" | "queued_new" | "queued_merged" } {
    const { conversationKey, content, meta } = params;
    const state = this.conversations.get(conversationKey);

    // 没有活跃会话 → 创建新的活跃批次
    if (!state) {
      const batchKey = conversationKey;
      const batch: PendingBatch<T> = {
        conversationKey, batchKey, contents: [content], meta,
        createdAt: Date.now(), timeout: null, readyToFlush: false,
      };
      batch.timeout = setTimeout(() => this.requestFlush(batchKey), this.debounceMs);
      this.pending.set(batchKey, batch);
      this.conversations.set(conversationKey, { activeBatchKey: batchKey, queue: [], nextSeq: 1 });
      return { batchKey, status: "active_new" };
    }

    // 活跃批次还没开始处理 → 合并
    const activeBatch = this.pending.get(state.activeBatchKey);
    if (activeBatch) {
      activeBatch.contents.push(content);
      if (activeBatch.timeout) clearTimeout(activeBatch.timeout);
      activeBatch.timeout = setTimeout(() => this.requestFlush(state.activeBatchKey), this.debounceMs);
      return { batchKey: state.activeBatchKey, status: "active_merged" };
    }

    // 活跃批次已在处理中 → 检查队列中是否有待处理批次
    const queuedKey = state.queue[0];
    if (queuedKey) {
      const queued = this.pending.get(queuedKey);
      if (queued) {
        queued.contents.push(content);
        if (queued.timeout) clearTimeout(queued.timeout);
        queued.timeout = setTimeout(() => this.requestFlush(queuedKey), this.debounceMs);
        return { batchKey: queuedKey, status: "queued_merged" };
      }
    }

    // 创建新的排队批次
    const seq = state.nextSeq++;
    const batchKey = `${conversationKey}#q${seq}`;
    state.queue = [batchKey];
    const batch: PendingBatch<T> = {
      conversationKey, batchKey, contents: [content], meta,
      createdAt: Date.now(), timeout: null, readyToFlush: false,
    };
    batch.timeout = setTimeout(() => this.requestFlush(batchKey), this.debounceMs);
    this.pending.set(batchKey, batch);
    return { batchKey, status: "queued_new" };
  }

  /** 当前批次处理完成后调用，推进队列中的下一个批次 */
  onBatchFinished(conversationKey: string): void {
    const conv = this.conversations.get(conversationKey);
    if (!conv) return;

    const next = conv.queue.shift();
    if (!next) {
      this.conversations.delete(conversationKey);
      return;
    }
    conv.activeBatchKey = next;

    const batch = this.pending.get(next);
    if (batch?.readyToFlush) {
      this.flushBatch(next);
    }
  }

  /** 清理过期条目 */
  prune(ttlMs: number = 10 * 60 * 1000): void {
    const cutoff = Date.now() - ttlMs;
    for (const [key, batch] of this.pending.entries()) {
      if (batch.createdAt < cutoff) {
        if (batch.timeout) clearTimeout(batch.timeout);
        this.pending.delete(key);
      }
    }
    for (const [convKey, conv] of this.conversations.entries()) {
      const hasActive = this.pending.has(conv.activeBatchKey);
      if (!hasActive && conv.queue.length === 0) {
        this.conversations.delete(convKey);
      }
    }
  }

  private requestFlush(batchKey: string): void {
    const batch = this.pending.get(batchKey);
    if (!batch) return;

    const conv = this.conversations.get(batch.conversationKey);
    if (conv?.activeBatchKey !== batchKey) {
      // 不是当前活跃批次，标记为就绪等待
      if (batch.timeout) { clearTimeout(batch.timeout); batch.timeout = null; }
      batch.readyToFlush = true;
      return;
    }
    this.flushBatch(batchKey);
  }

  private flushBatch(batchKey: string): void {
    const batch = this.pending.get(batchKey);
    if (!batch) return;
    this.pending.delete(batchKey);
    if (batch.timeout) { clearTimeout(batch.timeout); batch.timeout = null; }
    batch.readyToFlush = false;
    this.onFlush?.(batch);
  }
}
