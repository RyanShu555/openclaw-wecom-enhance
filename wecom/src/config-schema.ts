import { z } from "zod";

type JsonSchemaCapable = {
  toJSONSchema?: () => unknown;
};

function ensureJsonSchema<T extends JsonSchemaCapable>(schema: T): T {
  if (typeof schema.toJSONSchema === "function") return schema;
  return Object.assign(schema, {
    // Fallback for runtimes that expect Zod toJSONSchema.
    toJSONSchema: () => ({ type: "object" }),
  });
}

const allowFromEntry = z.union([z.string(), z.number()]);

const dmSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
    allowFrom: z.array(allowFromEntry).optional(),
  })
  .optional();

const visionSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  maxTokens: z.number().optional(),
  timeoutMs: z.number().optional(),
  maxBytes: z.number().optional(),
}).optional();

const autoFileSchema = z.object({
  enabled: z.boolean().optional(),
  textMaxBytes: z.number().optional(),
  textMaxChars: z.number().optional(),
  extensions: z.array(z.string()).optional(),
}).optional();

const autoAudioSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  timeoutMs: z.number().optional(),
  maxBytes: z.number().optional(),
}).optional();

const autoVideoSchema = z.object({
  enabled: z.boolean().optional(),
  ffmpegPath: z.string().optional(),
  maxBytes: z.number().optional(),
  mode: z.enum(["light", "full"]).optional(),
  frames: z.number().optional(),
  intervalSec: z.number().optional(),
  maxDurationSec: z.number().optional(),
  maxFrames: z.number().optional(),
  includeAudio: z.boolean().optional(),
}).optional();

const mediaSchema = z.object({
  tempDir: z.string().optional(),
  searchPaths: z.array(z.string()).optional(),
  retentionHours: z.number().optional(),
  cleanupOnStart: z.boolean().optional(),
  maxBytes: z.number().optional(),
  vision: visionSchema,
  auto: z.object({
    enabled: z.boolean().optional(),
    file: autoFileSchema,
    audio: autoAudioSchema,
    video: autoVideoSchema,
  }).optional(),
}).optional();

const networkSchema = z.object({
  timeoutMs: z.number().optional(),
  retries: z.number().optional(),
  retryDelayMs: z.number().optional(),
  egressProxyUrl: z.string().optional(),
}).optional();

const dynamicAgentsSchema = z.object({
  enabled: z.boolean().optional(),
  dmCreateAgent: z.boolean().optional(),
  groupEnabled: z.boolean().optional(),
  adminUsers: z.array(z.string()).optional(),
}).optional();

const sendQueueSchema = z.object({
  intervalMs: z.number().optional(),
}).optional();

const operationsSchema = z.object({
  logPath: z.string().optional(),
}).optional();

/** 共享的账户级字段 */
const accountFields = {
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  mode: z.enum(["bot", "app", "both"]).optional(),
  webhookPath: z.string().optional(),
  welcomeText: z.string().optional(),
  dm: dmSchema,

  // Bot API
  token: z.string().optional(),
  encodingAESKey: z.string().optional(),
  receiveId: z.string().optional(),

  // Internal app
  corpId: z.string().optional(),
  corpSecret: z.string().optional(),
  agentId: z.union([z.string(), z.number()]).optional(),
  callbackToken: z.string().optional(),
  callbackAesKey: z.string().optional(),
  pushToken: z.string().optional(),

  workspace: z.string().optional(),

  media: mediaSchema,
  network: networkSchema,
  botMediaBridge: z.boolean().optional(),
  debounceMs: z.number().optional(),
  dynamicAgents: dynamicAgentsSchema,
  sendQueue: sendQueueSchema,
  operations: operationsSchema,
} as const;

const accountSchema = z.object(accountFields);

export const WecomConfigSchema = ensureJsonSchema(z.object({
  ...accountFields,
  defaultAccount: z.string().optional(),
  accounts: z.object({}).catchall(accountSchema).optional(),
}));
