/**
 * WeCom 配置统一导出层。
 */

export { WecomConfigSchema, type WecomConfigInput } from "../config-schema.js";
export {
  DEFAULT_ACCOUNT_ID,
  listWecomAccountIds,
  resolveDefaultWecomAccountId,
  resolveWecomAccount,
} from "../accounts.js";
