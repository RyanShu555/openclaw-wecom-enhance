import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

import type {
  ResolvedWecomAccount,
  WecomAccountConfig,
  WecomAccountConflict,
  WecomConfig,
  WecomMode,
} from "./types.js";

function resolveEnvValue(cfg: ClawdbotConfig, name: string): string | undefined {
  const envVars = (cfg as any)?.env?.vars ?? {};
  const fromCfg = envVars[name];
  if (fromCfg != null && String(fromCfg).trim() !== "") return String(fromCfg).trim();
  const fromProcess = process.env[name];
  if (fromProcess != null && fromProcess.trim() !== "") return fromProcess.trim();
  return undefined;
}

function resolveAccountEnv(cfg: ClawdbotConfig, accountId: string, key: string): string | undefined {
  const prefix = accountId === DEFAULT_ACCOUNT_ID ? "WECOM" : `WECOM_${accountId.toUpperCase()}`;
  return resolveEnvValue(cfg, `${prefix}_${key}`);
}

function listConfiguredAccountIds(cfg: ClawdbotConfig): string[] {
  const accounts = (cfg.channels?.wecom as WecomConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter(
    (k) => k && k !== "default" && typeof accounts[k] === "object" && accounts[k] !== null,
  );
}

export function listWecomAccountIds(cfg: ClawdbotConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultWecomAccountId(cfg: ClawdbotConfig): string {
  const wecomConfig = cfg.channels?.wecom as WecomConfig | undefined;
  const ids = listWecomAccountIds(cfg);
  // 优先读 accounts.default（OpenClaw 推荐写法），再回退 defaultAccount
  const accountsDefault = (wecomConfig?.accounts as Record<string, unknown> | undefined)?.default;
  if (typeof accountsDefault === "string" && accountsDefault.trim() && ids.includes(accountsDefault.trim())) {
    return accountsDefault.trim();
  }
  if (wecomConfig?.defaultAccount?.trim() && ids.includes(wecomConfig.defaultAccount.trim())) {
    return wecomConfig.defaultAccount.trim();
  }
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(cfg: ClawdbotConfig, accountId: string): WecomAccountConfig | undefined {
  const accounts = (cfg.channels?.wecom as WecomConfig | undefined)?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  const entry = accounts[accountId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  return entry as WecomAccountConfig;
}

function mergeWecomAccountConfig(cfg: ClawdbotConfig, accountId: string): WecomAccountConfig {
  const raw = (cfg.channels?.wecom ?? {}) as WecomConfig;
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = raw;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  const merged: WecomAccountConfig = { ...base, ...account };
  if (base.bot || account.bot) {
    merged.bot = { ...(base.bot ?? {}), ...(account.bot ?? {}) };
  }
  if (base.agent || account.agent) {
    merged.agent = { ...(base.agent ?? {}), ...(account.agent ?? {}) };
  }
  return merged;
}

function pickTrimmed(...candidates: Array<string | undefined | null>): string | undefined {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const value = String(candidate).trim();
    if (value) return value;
  }
  return undefined;
}

function resolveMode(raw: string | undefined, configuredBot: boolean, configuredApp: boolean): WecomMode {
  if (raw === "bot" || raw === "app" || raw === "both") return raw;
  if (configuredBot && configuredApp) return "both";
  if (configuredBot) return "bot";
  if (configuredApp) return "app";
  return "both";
}

export function resolveWecomAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedWecomAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = (params.cfg.channels?.wecom as WecomConfig | undefined)?.enabled !== false;
  const merged = mergeWecomAccountConfig(params.cfg, accountId);
  const enabled = baseEnabled && merged.enabled !== false;
  const bot = merged.bot ?? {};
  const agent = merged.agent ?? {};

  const token = pickTrimmed(
    merged.token,
    bot.token,
    resolveAccountEnv(params.cfg, accountId, "TOKEN"),
  );
  const encodingAESKey = pickTrimmed(
    merged.encodingAESKey,
    bot.encodingAESKey,
    resolveAccountEnv(params.cfg, accountId, "ENCODING_AES_KEY"),
  );
  const receiveId = pickTrimmed(
    merged.receiveId,
    bot.receiveId,
    resolveAccountEnv(params.cfg, accountId, "RECEIVE_ID"),
  ) ?? "";

  const corpId = pickTrimmed(
    merged.corpId,
    agent.corpId,
    resolveAccountEnv(params.cfg, accountId, "CORP_ID"),
  );
  const corpSecret = pickTrimmed(
    merged.corpSecret,
    agent.corpSecret,
    resolveAccountEnv(params.cfg, accountId, "CORP_SECRET"),
  );
  const agentIdRaw = merged.agentId != null
    ? String(merged.agentId)
    : (agent.agentId != null ? String(agent.agentId) : resolveAccountEnv(params.cfg, accountId, "AGENT_ID"));
  const agentIdNum = agentIdRaw != null ? Number(agentIdRaw) : NaN;
  const agentId = Number.isFinite(agentIdNum) && agentIdNum > 0 ? agentIdNum : undefined;
  const callbackToken = pickTrimmed(
    merged.callbackToken,
    agent.callbackToken,
    agent.token,
    resolveAccountEnv(params.cfg, accountId, "CALLBACK_TOKEN"),
  );
  const callbackAesKey = pickTrimmed(
    merged.callbackAesKey,
    agent.callbackAesKey,
    agent.encodingAESKey,
    resolveAccountEnv(params.cfg, accountId, "CALLBACK_AES_KEY"),
  );
  const pushToken = pickTrimmed(
    merged.pushToken,
    agent.pushToken,
    resolveAccountEnv(params.cfg, accountId, "PUSH_TOKEN"),
  );
  const webhookPath = pickTrimmed(
    merged.webhookPath,
    resolveAccountEnv(params.cfg, accountId, "WEBHOOK_PATH"),
  );

  const configuredBot = Boolean(token && encodingAESKey);
  const configuredApp = Boolean(corpId && corpSecret && agentId);
  const configured = configuredBot || configuredApp;

  const mode = resolveMode(merged.mode, configuredBot, configuredApp);

  const mergedConfig: WecomAccountConfig = {
    ...merged,
    webhookPath,
    token,
    encodingAESKey,
    receiveId,
    corpId,
    corpSecret,
    agentId,
    callbackToken,
    callbackAesKey,
    pushToken,
    bot: {
      ...(merged.bot ?? {}),
      token,
      encodingAESKey,
      receiveId,
    },
    agent: {
      ...(merged.agent ?? {}),
      corpId,
      corpSecret,
      agentId,
      callbackToken,
      callbackAesKey,
      token: callbackToken,
      encodingAESKey: callbackAesKey,
      pushToken,
    },
  };

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    configured,
    mode,
    token,
    encodingAESKey,
    receiveId,
    corpId,
    corpSecret,
    agentId,
    callbackToken,
    callbackAesKey,
    config: mergedConfig,
  };
}

export function listEnabledWecomAccounts(cfg: ClawdbotConfig): ResolvedWecomAccount[] {
  return listWecomAccountIds(cfg)
    .map((accountId) => resolveWecomAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

function normalizeDuplicateKey(value: string): string {
  return value.trim().toLowerCase();
}

function collectWecomAccountConflicts(cfg: ClawdbotConfig): Map<string, WecomAccountConflict> {
  const conflicts = new Map<string, WecomAccountConflict>();
  const botTokenOwners = new Map<string, string>();
  const appIdentityOwners = new Map<string, string>();
  const appCallbackOwners = new Map<string, string>();

  for (const accountId of listWecomAccountIds(cfg)) {
    const account = resolveWecomAccount({ cfg, accountId });
    if (!account.enabled) continue;

    const botToken = account.token?.trim();
    if (botToken) {
      const key = normalizeDuplicateKey(botToken);
      const owner = botTokenOwners.get(key);
      if (owner && owner !== account.accountId && !conflicts.has(account.accountId)) {
        conflicts.set(account.accountId, {
          type: "duplicate_bot_token",
          accountId: account.accountId,
          ownerAccountId: owner,
          message:
            `WeCom Bot token 冲突：账号 "${account.accountId}" 与 "${owner}" 使用了相同 token。` +
            "请为每个账号配置唯一 Bot token。",
        });
      } else if (!owner) {
        botTokenOwners.set(key, account.accountId);
      }
    }

    const corpId = account.corpId?.trim();
    const agentId = account.agentId;
    if (corpId && agentId) {
      const key = `${normalizeDuplicateKey(corpId)}:${agentId}`;
      const owner = appIdentityOwners.get(key);
      if (owner && owner !== account.accountId && !conflicts.has(account.accountId)) {
        conflicts.set(account.accountId, {
          type: "duplicate_app_identity",
          accountId: account.accountId,
          ownerAccountId: owner,
          message:
            `WeCom App 身份冲突：账号 "${account.accountId}" 与 "${owner}" 复用了同一 corpId/agentId (${corpId}/${agentId})。` +
            "请保持每个账号唯一。",
        });
      } else if (!owner) {
        appIdentityOwners.set(key, account.accountId);
      }
    }

    const callbackToken = account.callbackToken?.trim();
    const callbackAesKey = account.callbackAesKey?.trim();
    if (callbackToken && callbackAesKey) {
      const key = `${normalizeDuplicateKey(callbackToken)}:${normalizeDuplicateKey(callbackAesKey)}`;
      const owner = appCallbackOwners.get(key);
      if (owner && owner !== account.accountId && !conflicts.has(account.accountId)) {
        conflicts.set(account.accountId, {
          type: "duplicate_app_callback",
          accountId: account.accountId,
          ownerAccountId: owner,
          message:
            `WeCom App 回调凭据冲突：账号 "${account.accountId}" 与 "${owner}" 使用了相同 callbackToken/callbackAesKey。` +
            "请确保每个账号回调凭据唯一。",
        });
      } else if (!owner) {
        appCallbackOwners.set(key, account.accountId);
      }
    }
  }

  return conflicts;
}

export function resolveWecomAccountConflict(params: {
  cfg: ClawdbotConfig;
  accountId: string;
}): WecomAccountConflict | undefined {
  const accountId = normalizeAccountId(params.accountId);
  return collectWecomAccountConflicts(params.cfg).get(accountId);
}
