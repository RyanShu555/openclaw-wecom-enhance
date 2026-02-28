/**
 * 动态 Agent 路由
 *
 * 为每个用户/群聊自动创建独立的 agent，实现会话隔离。
 * - DM: wecom-dm-{userid}
 * - 群聊: wecom-group-{chatid}
 * - admin 用户绕过动态路由，走主 agent
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";
import type { WecomAccountConfig } from "./types.js";

export type DynamicAgentConfig = NonNullable<WecomAccountConfig["dynamicAgents"]>;

const registeredAgents = new Set<string>();
const pendingWrites = new Map<string, Promise<void>>();

export function shouldUseDynamicAgent(params: {
  config: DynamicAgentConfig | undefined;
  userId: string;
  isGroup: boolean;
}): boolean {
  const { config, userId, isGroup } = params;
  if (!config?.enabled) return false;
  // admin 用户绕过
  if (config.adminUsers?.some((u) => u.toLowerCase() === userId.toLowerCase())) {
    return false;
  }
  if (isGroup) return config.groupEnabled !== false;
  return config.dmCreateAgent !== false;
}

export function generateAgentId(params: {
  userId: string;
  chatId?: string;
  isGroup: boolean;
}): string {
  const { userId, chatId, isGroup } = params;
  if (isGroup && chatId) {
    return `wecom-group-${chatId}`;
  }
  return `wecom-dm-${userId}`;
}

/**
 * 确保动态 agent 已注册到 agents.list 配置中。
 * 幂等操作，使用内存缓存避免重复写入。
 */
export async function ensureDynamicAgentListed(params: {
  core: PluginRuntime;
  agentId: string;
  label?: string;
}): Promise<void> {
  const { core, agentId, label } = params;
  if (registeredAgents.has(agentId)) return;

  // 防止并发写入
  const existing = pendingWrites.get(agentId);
  if (existing) { await existing; return; }

  const promise = (async () => {
    try {
      // 检查 agent 是否已存在
      const agents = core.agents?.list?.() ?? [];
      const found = agents.some?.((a: any) => a?.id === agentId || a === agentId);
      if (found) {
        registeredAgents.add(agentId);
        return;
      }
      // 注册新 agent
      await core.agents?.register?.({
        id: agentId,
        label: label || agentId,
        channel: "wecom",
      });
      registeredAgents.add(agentId);
    } catch {
      // 注册失败不阻塞消息处理
    } finally {
      pendingWrites.delete(agentId);
    }
  })();

  pendingWrites.set(agentId, promise);
  await promise;
}
