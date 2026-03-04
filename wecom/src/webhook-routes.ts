import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

import type { ResolvedWecomAccount } from "./types.js";

export const WECOM_LEGACY_BASE_PATH = "/wecom";
export const WECOM_LEGACY_BOT_BASE = "/wecom/bot";
export const WECOM_LEGACY_AGENT_BASE = "/wecom/agent";
export const WECOM_PLUGIN_BOT_BASE = "/plugins/wecom/bot";
export const WECOM_PLUGIN_AGENT_BASE = "/plugins/wecom/agent";

export function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) return withSlash.slice(0, -1);
  return withSlash;
}

function pushPathOf(basePath: string): string {
  return basePath.endsWith("/") ? `${basePath}push` : `${basePath}/push`;
}

function addPath(paths: Set<string>, value: string): void {
  const normalized = normalizeWebhookPath(value);
  if (normalized) paths.add(normalized);
}

function buildAccountPath(base: string, accountId: string): string {
  return `${normalizeWebhookPath(base)}/${accountId}`;
}

export type WecomWebhookRoutePlan = {
  primaryPath: string;
  callbackPaths: string[];
  pushPaths: string[];
  suggestedBotPath: string;
  suggestedAgentPath: string;
};

export function resolveWecomWebhookRoutePlan(account: ResolvedWecomAccount): WecomWebhookRoutePlan {
  const accountId = normalizeAccountId(account.accountId);
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;
  const supportsBot = account.mode === "bot" || account.mode === "both";
  const supportsApp = account.mode === "app" || account.mode === "both";

  const suggestedBotPath = buildAccountPath(WECOM_PLUGIN_BOT_BASE, accountId);
  const suggestedAgentPath = buildAccountPath(WECOM_PLUGIN_AGENT_BASE, accountId);
  const configuredPath = normalizeWebhookPath(account.config.webhookPath ?? WECOM_LEGACY_BASE_PATH);

  const callbackSet = new Set<string>();
  const pushSet = new Set<string>();
  addPath(callbackSet, configuredPath);
  if (supportsApp) addPath(pushSet, configuredPath);

  if (supportsBot) {
    addPath(callbackSet, suggestedBotPath);
    addPath(callbackSet, buildAccountPath(WECOM_LEGACY_BOT_BASE, accountId));
    if (isDefault) {
      addPath(callbackSet, WECOM_PLUGIN_BOT_BASE);
      addPath(callbackSet, WECOM_LEGACY_BOT_BASE);
    }
  }

  if (supportsApp) {
    addPath(callbackSet, suggestedAgentPath);
    addPath(callbackSet, buildAccountPath(WECOM_LEGACY_AGENT_BASE, accountId));
    addPath(pushSet, suggestedAgentPath);
    addPath(pushSet, buildAccountPath(WECOM_LEGACY_AGENT_BASE, accountId));
    if (isDefault) {
      addPath(callbackSet, WECOM_PLUGIN_AGENT_BASE);
      addPath(callbackSet, WECOM_LEGACY_AGENT_BASE);
      addPath(pushSet, WECOM_PLUGIN_AGENT_BASE);
      addPath(pushSet, WECOM_LEGACY_AGENT_BASE);
    }
  }

  const callbackPaths = Array.from(callbackSet).sort((a, b) => a.localeCompare(b));
  const pushPaths = Array.from(pushSet).sort((a, b) => a.localeCompare(b)).map((path) => pushPathOf(path));

  const primaryPath = supportsBot
    ? suggestedBotPath
    : suggestedAgentPath;

  return {
    primaryPath,
    callbackPaths,
    pushPaths,
    suggestedBotPath,
    suggestedAgentPath,
  };
}
