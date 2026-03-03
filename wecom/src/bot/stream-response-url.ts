import type { WecomWebhookTarget } from "../monitor.js";
import {
  formatErrorDetail,
  truncateUtf8Bytes,
} from "../shared/string-utils.js";
import {
  STREAM_MAX_BYTES,
  streams,
} from "./state.js";

const RESPONSE_URL_PUSH_DELAY_MS = 1500;

async function postResponseUrlJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`response_url status ${res.status}`);
  }
}

async function pushFinalViaResponseUrl(params: {
  target: WecomWebhookTarget;
  streamId: string;
}): Promise<void> {
  const { target, streamId } = params;
  const state = streams.get(streamId);
  if (!state) return;
  if (!state.finished || !state.responseUrl || state.pushedViaResponseUrlAt) return;

  const text = truncateUtf8Bytes(state.content.trim(), STREAM_MAX_BYTES);
  if (!text) return;

  const finishedAt = state.finishedAt ?? state.updatedAt;
  const lastRefreshAt = state.lastRefreshAt ?? 0;
  if (lastRefreshAt >= finishedAt) return;

  try {
    await postResponseUrlJson(state.responseUrl, {
      msgtype: "stream",
      stream: {
        id: state.streamId,
        finish: true,
        content: text,
      },
    });
    state.pushedViaResponseUrlAt = Date.now();
    state.updatedAt = state.pushedViaResponseUrlAt;
    target.statusSink?.({ lastOutboundAt: Date.now() });
    target.runtime.log?.(`[wecom] bot final reply pushed via response_url streamId=${state.streamId}`);
    return;
  } catch (err) {
    target.runtime.error?.(
      `[${target.account.accountId}] wecom bot response_url stream push failed: ${formatErrorDetail(err)}`,
    );
  }

  try {
    await postResponseUrlJson(state.responseUrl, {
      msgtype: "text",
      text: { content: text },
    });
    state.pushedViaResponseUrlAt = Date.now();
    state.updatedAt = state.pushedViaResponseUrlAt;
    target.statusSink?.({ lastOutboundAt: Date.now() });
    target.runtime.log?.(`[wecom] bot final text pushed via response_url streamId=${state.streamId}`);
  } catch (err) {
    target.runtime.error?.(
      `[${target.account.accountId}] wecom bot response_url text push failed: ${formatErrorDetail(err)}`,
    );
  }
}

export function scheduleFinalResponseUrlPush(params: {
  target: WecomWebhookTarget;
  streamId: string;
}): void {
  const timer = setTimeout(() => {
    void pushFinalViaResponseUrl(params);
  }, RESPONSE_URL_PUSH_DELAY_MS);
  const unref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof unref === "function") {
    unref.call(timer);
  }
}

