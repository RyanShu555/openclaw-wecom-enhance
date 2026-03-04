import type { IncomingMessage, ServerResponse } from "node:http";

import { registerWebhookTargetWithPluginRoute, type ClawdbotConfig } from "openclaw/plugin-sdk";

import type { ResolvedWecomAccount } from "./types.js";
import { handleWecomAppWebhook, handleWecomPushRequest } from "./wecom-app.js";
import { handleWecomBotWebhook } from "./wecom-bot.js";
import { readRequestBody } from "./shared/http-utils.js";
import { normalizeWebhookPath } from "./webhook-routes.js";

const MAX_WEBHOOK_BODY_SIZE = 1024 * 1024;

export type WecomRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type WecomWebhookTarget = {
  account: ResolvedWecomAccount;
  config: ClawdbotConfig;
  runtime: WecomRuntimeEnv;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const webhookTargets = new Map<string, WecomWebhookTarget[]>();

function resolvePath(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  return normalizeWebhookPath(url.pathname || "/");
}

export function registerWecomWebhookTarget(target: WecomWebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const registered = registerWebhookTargetWithPluginRoute({
    targetsByPath: webhookTargets,
    target: normalizedTarget,
    route: {
      auth: "plugin",
      match: "exact",
      pluginId: "openclaw-wecom",
      source: "wecom-webhook",
      accountId: normalizedTarget.account.accountId,
      log: normalizedTarget.runtime.log,
      handler: async (req, res) => {
        const handled = await handleWecomWebhookRequest(req, res);
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
        }
      },
    },
  });
  return () => {
    registered.unregister();
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
