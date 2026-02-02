import type { ClawdbotConfig } from "openclaw/plugin-sdk";

import type { WecomAccountConfig } from "./types.js";

export type VisionConfig = {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  prompt?: string;
  maxTokens?: number;
  timeoutMs?: number;
  maxBytes?: number;
};

function resolveBaseUrl(raw?: string): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (value.endsWith("/v1")) return value;
  return `${value.replace(/\/+$/, "")}/v1`;
}

function parseProviderModelId(raw?: string): { providerId: string; modelId: string } | null {
  const value = raw?.trim();
  if (!value) return null;
  const idx = value.indexOf("/");
  if (idx <= 0 || idx >= value.length - 1) return null;
  return { providerId: value.slice(0, idx), modelId: value.slice(idx + 1) };
}

function resolveFromOpenClawModels(coreConfig?: ClawdbotConfig): { baseUrl?: string; apiKey?: string; model?: string } {
  if (!coreConfig) return {};
  const primary = (coreConfig as any)?.agents?.defaults?.model?.primary as string | undefined;
  const parsed = parseProviderModelId(primary);
  if (!parsed) return {};
  const provider = (coreConfig as any)?.models?.providers?.[parsed.providerId] as any | undefined;
  if (!provider) return {};
  return {
    baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
    apiKey: typeof provider.apiKey === "string" ? provider.apiKey : undefined,
    model: parsed.modelId,
  };
}

export function resolveVisionConfig(accountConfig: WecomAccountConfig, coreConfig?: ClawdbotConfig): VisionConfig | null {
  const vision = accountConfig.media?.vision;
  if (!vision?.enabled) return null;

  const inherited = resolveFromOpenClawModels(coreConfig);
  const baseUrl = resolveBaseUrl(
    vision.baseUrl
      || process.env.OPENAI_BASE_URL
      || process.env.OPENAI_API_BASE
      || process.env.OPENAI_ENDPOINT,
  );
  const resolvedBaseUrl = baseUrl || resolveBaseUrl(inherited.baseUrl);
  const apiKey = vision.apiKey || process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || inherited.apiKey;
  if (!resolvedBaseUrl || !apiKey) return null;

  return {
    enabled: true,
    baseUrl: resolvedBaseUrl,
    apiKey,
    model: vision.model || process.env.OPENAI_MODEL || inherited.model || "gpt-4o-mini",
    prompt: vision.prompt
      || "请描述图片内容并尽量提取可见文字。输出简洁中文要点。",
    maxTokens: typeof vision.maxTokens === "number" ? vision.maxTokens : 400,
    timeoutMs: typeof vision.timeoutMs === "number" ? vision.timeoutMs : 15000,
    maxBytes: typeof vision.maxBytes === "number" ? vision.maxBytes : undefined,
  };
}

export async function describeImageWithVision(params: {
  config: VisionConfig;
  buffer: Buffer;
  mimeType: string;
}): Promise<string | null> {
  const { config, buffer, mimeType } = params;
  if (!config.enabled || !config.baseUrl || !config.apiKey) return null;

  if (config.maxBytes && buffer.length > config.maxBytes) {
    return null;
  }

  const imageBase64 = buffer.toString("base64");
  const payload = {
    model: config.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: config.prompt },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ],
      },
    ],
    max_tokens: config.maxTokens ?? 400,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15000);
    try {
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        continue;
      }
      const data = await res.json() as any;
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        continue;
      }
      const trimmed = content.trim();
      if (!trimmed) continue;
      return trimmed;
    } catch {
      // retry once
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
}
