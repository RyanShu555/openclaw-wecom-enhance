import { truncateUtf8Bytes } from "../shared/string-utils.js";
import { STREAM_MAX_BYTES, type StreamState } from "./state.js";

export function appendStreamText(state: StreamState, text: string): void {
  const nextText = state.content
    ? `${state.content}\n\n${text}`.trim()
    : text.trim();
  state.content = truncateUtf8Bytes(nextText, STREAM_MAX_BYTES);
  state.updatedAt = Date.now();
}

export function appendStreamMediaNote(state: StreamState, note: string): void {
  appendStreamText(state, note);
}
