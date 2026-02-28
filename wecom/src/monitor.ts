import type { IncomingMessage, ServerResponse } from "node:http";

import type { ClawdbotConfig, PluginRuntime } from "openclaw/plugin-sdk";

import type { ResolvedWecomAccount } from "./types.js";
import { handleWecomAppWebhook, handleWecomPushRequest } from "./wecom-app.js";
import { handleWecomBotWebhook } from "./wecom-bot.js";
import { readRequestBody } from "./shared/http-utils.js";

const MAX_WEBHOOK_BODY_SIZE = 1024 * 1024;

export type WecomRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type WecomWebhookTarget = {
  account: ResolvedWecomAccount;
  config: ClawdbotConfig;
  runtime: WecomRuntimeEnv;
  core: PluginRuntime;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const webhookTargets = new Map<string, WecomWebhookTarget[]>();

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
  return withSlash;
}

function resolvePath(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  return normalizeWebhookPath(url.pathname || "/");
}

export function registerWecomWebhookTarget(target: WecomWebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) webhookTargets.set(key, updated);
    else webhookTargets.delete(key);
  };
}

export async function handleWecomWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const path = resolvePath(req);
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) return false;
  if (path.endsWith("/push")) {
    return await handleWecomPushRequest({ req, res, targets });
  }
  const firstTarget = targets[0];
  const ua = req.headers["user-agent"] ?? "";
  const fwd = req.headers["x-forwarded-for"] ?? "";
  const ct = req.headers["content-type"] ?? "";
  firstTarget?.runtime?.log?.(`[wecom] webhook ${req.method ?? "UNKNOWN"} ${req.url ?? ""} ct=${ct} ua=${ua} fwd=${fwd}`);

  // Prefer account-level mode. If both, we attempt bot first (JSON) then app (XML).
  // Concrete routing is implemented in handlers.
  // Buffer the body once so both handlers can use it without re-reading the stream.
  let rawBody: string | undefined;
  if (req.method === "POST") {
    try {
      rawBody = await readRequestBody(req, MAX_WEBHOOK_BODY_SIZE);
    } catch (err) {
      res.statusCode = 413;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(err instanceof Error ? err.message : "payload too large");
      return true;
    }
  }

  const botHandled = await handleWecomBotWebhook({ req, res, targets, rawBody });
  if (botHandled) return true;

  const appHandled = await handleWecomAppWebhook({ req, res, targets, rawBody });
  if (appHandled) return true;

  // Fallback: not a recognized request for this plugin.
  res.statusCode = 400;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("unsupported wecom webhook request");
  return true;
}
