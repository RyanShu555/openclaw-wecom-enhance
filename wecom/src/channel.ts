import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
  ClawdbotConfig,
} from "openclaw/plugin-sdk";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk";

import {
  listWecomAccountIds,
  resolveDefaultWecomAccountId,
  resolveWecomAccountConflict,
  resolveWecomAccount,
  WecomConfigSchema,
} from "./config/index.js";
import type { ResolvedWecomAccount } from "./types.js";
import { registerWecomWebhookTarget } from "./monitor.js";
import { getWecomAccessToken } from "./wecom-api.js";
import { WecomApiError } from "./shared/string-utils.js";
import { resolveWecomWebhookRoutePlan } from "./webhook-routes.js";

const meta = {
  id: "wecom",
  label: "WeCom",
  selectionLabel: "WeCom (plugin)",
  docsPath: "/channels/wecom",
  docsLabel: "wecom",
  blurb: "Enterprise WeCom: bot API + internal app (dual mode).",
  aliases: ["wechatwork", "wework", "qywx", "企微", "企业微信"],
  order: 85,
  quickstartAllowFrom: true,
};

function normalizeWecomMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^(wecom|wechatwork|wework|qywx):/i, "").trim() || undefined;
}

type ParsedWecomTarget = {
  toUser?: string;
  chatId?: string;
  toParty?: string;
  toTag?: string;
};

function parseWecomTarget(raw: string): ParsedWecomTarget | null {
  const normalized = normalizeWecomMessagingTarget(raw) ?? "";
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  const parsePrefixed = (prefixes: string[]): string | undefined => {
    const prefix = prefixes.find((candidate) => lower.startsWith(candidate));
    if (!prefix) return undefined;
    const value = normalized.slice(prefix.length).trim();
    return value || undefined;
  };
  const chatId = parsePrefixed(["chat:", "chatid:", "group:"]);
  if (chatId) return { chatId };
  const toParty = parsePrefixed(["party:", "dept:", "department:"]);
  if (toParty) return { toParty };
  const toTag = parsePrefixed(["tag:"]);
  if (toTag) return { toTag };
  return { toUser: normalized };
}

export const wecomPlugin: ChannelPlugin<ResolvedWecomAccount> = {
  id: "wecom",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.wecom"] },
  configSchema: buildChannelConfigSchema(WecomConfigSchema),
  config: {
    listAccountIds: (cfg) => listWecomAccountIds(cfg as ClawdbotConfig),
    resolveAccount: (cfg, accountId) => resolveWecomAccount({ cfg: cfg as ClawdbotConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultWecomAccountId(cfg as ClawdbotConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as ClawdbotConfig,
        sectionKey: "wecom",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as ClawdbotConfig,
        sectionKey: "wecom",
        clearBaseFields: [
          "name",
          "webhookPath",
          "token",
          "encodingAESKey",
          "receiveId",
          "corpId",
          "corpSecret",
          "agentId",
          "callbackToken",
          "callbackAesKey",
          "bot",
          "agent",
          "welcomeText",
        ],
        accountId,
      }),
    isConfigured: (account, cfg) => {
      if (!account.configured) return false;
      return !resolveWecomAccountConflict({
        cfg: cfg as ClawdbotConfig,
        accountId: account.accountId,
      });
    },
    unconfiguredReason: (account, cfg) =>
      resolveWecomAccountConflict({
        cfg: cfg as ClawdbotConfig,
        accountId: account.accountId,
      })?.message ?? "not configured",
    describeAccount: (account, cfg): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured && !resolveWecomAccountConflict({
        cfg: cfg as ClawdbotConfig,
        accountId: account.accountId,
      }),
      webhookPath: resolveWecomWebhookRoutePlan(account).primaryPath,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveWecomAccount({ cfg: cfg as ClawdbotConfig, accountId });
      return (account.config.dm?.allowFrom ?? []).map((entry) => String(entry));
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const accountEntry = (cfg as ClawdbotConfig).channels?.wecom?.accounts?.[resolvedAccountId];
      const useAccountPath = Boolean(accountEntry && typeof accountEntry === "object");
      const basePath = useAccountPath ? `channels.wecom.accounts.${resolvedAccountId}.` : "channels.wecom.";
      return {
        policy: account.config.dm?.policy ?? "pairing",
        allowFrom: (account.config.dm?.allowFrom ?? []).map((entry) => String(entry)),
        policyPath: `${basePath}dm.policy`,
        allowFromPath: `${basePath}dm.allowFrom`,
        approveHint: formatPairingApproveHint("wecom"),
        normalizeEntry: (raw) => raw.trim().toLowerCase(),
      };
    },
  },
  groups: {
    resolveRequireMention: () => true,
  },
  threading: {
    resolveReplyToMode: () => "off",
  },
  messaging: {
    normalizeTarget: normalizeWecomMessagingTarget,
    targetResolver: {
      looksLikeId: (raw) => Boolean(raw.trim()),
      hint: "<userid|chatid>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "text",
    textChunkLimit: 20480,
    sendText: async ({ cfg, to, text, accountId }) => {
      try {
        const resolvedAccount = accountId?.trim() || resolveDefaultWecomAccountId(cfg as ClawdbotConfig);
        const account = resolveWecomAccount({ cfg: cfg as ClawdbotConfig, accountId: resolvedAccount });
        const parsedTarget = typeof to === "string" ? parseWecomTarget(to) : null;
        if (!parsedTarget) {
          return {
            channel: "wecom",
            ok: false,
            messageId: "",
            error: new Error("WeCom outbound requires --to <userid|chatid|party:id|tag:id>."),
          };
        }
        if (!account.corpId || !account.corpSecret || !account.agentId) {
          return {
            channel: "wecom",
            ok: false,
            messageId: "",
            error: new Error("WeCom app outbound requires corpId/corpSecret/agentId (App mode)."),
          };
        }
        const { sendWecomText } = await import("./wecom-api.js");
        await sendWecomText({
          account,
          toUser: parsedTarget.toUser,
          chatId: parsedTarget.chatId,
          toParty: parsedTarget.toParty,
          toTag: parsedTarget.toTag,
          text: String(text ?? ""),
        });
        return {
          channel: "wecom",
          ok: true,
          messageId: "",
        };
      } catch (err) {
        return {
          channel: "wecom",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      try {
        const resolvedAccount = accountId?.trim() || resolveDefaultWecomAccountId(cfg as ClawdbotConfig);
        const account = resolveWecomAccount({ cfg: cfg as ClawdbotConfig, accountId: resolvedAccount });
        const parsedTarget = typeof to === "string" ? parseWecomTarget(to) : null;
        if (!parsedTarget) {
          return {
            channel: "wecom",
            ok: false,
            messageId: "",
            error: new Error("WeCom outbound requires --to <userid|chatid|party:id|tag:id>."),
          };
        }
        if (!account.corpId || !account.corpSecret || !account.agentId) {
          return {
            channel: "wecom",
            ok: false,
            messageId: "",
            error: new Error("WeCom app outbound requires corpId/corpSecret/agentId (App mode)."),
          };
        }
        if (!mediaUrl) {
          return {
            channel: "wecom",
            ok: false,
            messageId: "",
            error: new Error("WeCom sendMedia requires mediaUrl."),
          };
        }
        const { uploadWecomMedia, sendWecomMedia, sendWecomText } = await import("./wecom-api.js");
        const { readFile } = await import("node:fs/promises");
        const path = await import("path");
        const { stripFileProtocol } = await import("./shared/media-shared.js");

        let buffer: Buffer;
        let filename: string;
        if (mediaUrl.startsWith("file://") || mediaUrl.startsWith("/") || /^[a-zA-Z]:/.test(mediaUrl)) {
          const filePath = stripFileProtocol(mediaUrl);
          buffer = Buffer.from(await readFile(filePath));
          filename = path.basename(filePath);
        } else {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30000);
          try {
            const res = await fetch(mediaUrl, { signal: controller.signal });
            if (!res.ok) {
              throw new Error(`Failed to fetch media: ${res.status} ${res.statusText}`);
            }
            buffer = Buffer.from(await res.arrayBuffer());
            const urlPath = new URL(mediaUrl).pathname;
            filename = path.basename(urlPath) || "media";
          } finally {
            clearTimeout(timer);
          }
        }

        const ext = path.extname(filename).toLowerCase();
        let mediaType: "image" | "voice" | "video" | "file" = "file";
        if ([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"].includes(ext)) {
          mediaType = "image";
        } else if ([".amr", ".mp3", ".wav", ".m4a", ".ogg"].includes(ext)) {
          mediaType = "voice";
        } else if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext)) {
          mediaType = "video";
        }

        const mediaId = await uploadWecomMedia({ account, type: mediaType, buffer, filename });
        await sendWecomMedia({
          account,
          toUser: parsedTarget.toUser,
          chatId: parsedTarget.chatId,
          toParty: parsedTarget.toParty,
          toTag: parsedTarget.toTag,
          mediaId,
          mediaType,
        });

        if (text) {
          await sendWecomText({
            account,
            toUser: parsedTarget.toUser,
            chatId: parsedTarget.chatId,
            toParty: parsedTarget.toParty,
            toTag: parsedTarget.toTag,
            text: String(text),
          });
        }

        return {
          channel: "wecom",
          ok: true,
          messageId: "",
        };
      } catch (err) {
        return {
          channel: "wecom",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      webhookPath: snapshot.webhookPath ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, cfg }) => {
      const conflict = resolveWecomAccountConflict({
        cfg: cfg as ClawdbotConfig,
        accountId: account.accountId,
      });
      if (conflict) return { ok: false, error: conflict.message };
      // App 模式：尝试 gettoken 验证凭据 + IP 白名单
      if (account.corpId && account.corpSecret && account.agentId) {
        try {
          await getWecomAccessToken(account);
          return { ok: true };
        } catch (err) {
          const detail = err instanceof WecomApiError
            ? `errcode=${err.errcode}, errmsg=${err.errmsg}`
            : (err instanceof Error ? err.message : String(err));
          return { ok: false, error: detail };
        }
      }
      // Bot-only 模式：无主动探测手段，只能假设 ok
      return { ok: true };
    },
    buildAccountSnapshot: ({ account, runtime, cfg }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured && !resolveWecomAccountConflict({
        cfg: cfg as ClawdbotConfig,
        accountId: account.accountId,
      }),
      webhookPath: resolveWecomWebhookRoutePlan(account).primaryPath,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? resolveWecomAccountConflict({
        cfg: cfg as ClawdbotConfig,
        accountId: account.accountId,
      })?.message ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.config.dm?.policy ?? "pairing",
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const conflict = resolveWecomAccountConflict({
        cfg: ctx.cfg as ClawdbotConfig,
        accountId: account.accountId,
      });
      if (conflict) {
        ctx.log?.warn(`[${account.accountId}] ${conflict.message}`);
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          configured: false,
          lastError: conflict.message,
        });
        return;
      }
      if (!account.configured) {
        ctx.log?.warn(`[${account.accountId}] wecom not configured; skipping webhook registration`);
        ctx.setStatus({ accountId: account.accountId, running: false, configured: false });
        return;
      }
      const controlUi = (ctx.cfg as ClawdbotConfig).gateway?.controlUi as { enabled?: boolean } | undefined;
      if (controlUi?.enabled !== false) {
        ctx.log?.warn(
          `[${account.accountId}] gateway.controlUi.enabled=true may intercept WeCom webhook POST on some old OpenClaw versions (HTTP 405). ` +
          "If app/bot inbound has no logs, upgrade OpenClaw first; only use disabling Control UI as a temporary fallback.",
        );
      }
      const routePlan = resolveWecomWebhookRoutePlan(account);
      const unregisterFns: Array<() => void> = [];
      for (const path of routePlan.callbackPaths) {
        unregisterFns.push(registerWecomWebhookTarget({
          account,
          config: ctx.cfg as ClawdbotConfig,
          runtime: ctx.runtime,
          path,
          statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
        }));
      }
      for (const path of routePlan.pushPaths) {
        unregisterFns.push(registerWecomWebhookTarget({
          account,
          config: ctx.cfg as ClawdbotConfig,
          runtime: ctx.runtime,
          path,
          statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
        }));
      }
      ctx.log?.info(`[${account.accountId}] wecom callbacks registered at ${routePlan.callbackPaths.join(", ")}`);
      if (routePlan.pushPaths.length > 0) {
        ctx.log?.info(`[${account.accountId}] wecom push endpoints registered at ${routePlan.pushPaths.join(", ")}`);
      }
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        configured: true,
        webhookPath: routePlan.primaryPath,
        lastStartAt: Date.now(),
      });

      // Long-lived task: keep the Promise pending until the framework signals abort.
      // Without this, an immediately-resolved Promise causes OpenClaw core to treat
      // the channel as "exited" and trigger an infinite restart loop.
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        for (const unregister of unregisterFns) unregister();
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      };
      try {
        if (ctx.abortSignal.aborted) return;
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            ctx.abortSignal.removeEventListener("abort", onAbort);
            resolve();
          };
          ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
        });
      } finally {
        stop();
      }
    },
    stopAccount: async (ctx) => {
      ctx.setStatus({
        accountId: ctx.account.accountId,
        running: false,
        lastStopAt: Date.now(),
      });
    },
  },
};
