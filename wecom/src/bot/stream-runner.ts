import type { PluginRuntime } from "openclaw/plugin-sdk";

import type { WecomWebhookTarget } from "../monitor.js";
import type { WecomInboundMessage } from "../types.js";
import { getWecomRuntime } from "../runtime.js";
import { formatErrorDetail } from "../shared/string-utils.js";
import { streams } from "./state.js";
import type { StartAgentForStreamFn } from "./contracts.js";

export function startBotStreamAgentOrFinish(params: {
  target: WecomWebhookTarget;
  msg: WecomInboundMessage;
  streamId: string;
  startAgentForStream: StartAgentForStreamFn;
  onRuntimeNotReady?: (error: unknown) => void;
}): void {
  const { target, msg, streamId, startAgentForStream, onRuntimeNotReady } = params;

  let core: PluginRuntime | null = null;
  try {
    core = getWecomRuntime();
  } catch (err) {
    onRuntimeNotReady?.(err);
  }

  if (core) {
    const streamState = streams.get(streamId);
    if (streamState) streamState.started = true;
    startAgentForStream({ target, msg, streamId }).catch((err) => {
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
    });
    return;
  }

  const state = streams.get(streamId);
  if (state) {
    const now = Date.now();
    state.finished = true;
    state.finishedAt = now;
    state.updatedAt = now;
  }
}
