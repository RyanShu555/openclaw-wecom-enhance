# OpenClaw WeCom 技术说明

## 入口与路由

- 插件入口：`wecom/index.ts`
- HTTP 入口：`wecom/src/monitor.ts`
- App 入口壳层：`wecom/src/wecom-app.ts`
- Bot 入口壳层：`wecom/src/wecom-bot.ts`

## App 模式模块

- Webhook 流程：`wecom/src/app/webhook-handler.ts`
- 请求解析：`wecom/src/app/request-*.ts`
- XML 解析：`wecom/src/app/xml-parser.ts`
- 解密处理：`wecom/src/app/decrypt-handler.ts`
- 入站消息解析：`wecom/src/app/inbound-resolver.ts`
- 文本快捷分支：`wecom/src/app/text-shortcuts.ts`
- 回复投递：`wecom/src/app/reply-delivery.ts`
- 主动推送：`wecom/src/app/push-*.ts`
- 自然语言发文件：`wecom/src/app/file-*.ts`

## Bot 模式模块

- Webhook 流程：`wecom/src/bot/webhook-handler.ts`
- 请求解析：`wecom/src/bot/request-*.ts`
- 解密处理：`wecom/src/bot/decrypt-handler.ts`
- 去重与消息解析：`wecom/src/bot/dedupe-handler.ts` / `plain-message-parser.ts`
- 消息路由：`wecom/src/bot/message-router.ts`
- 事件处理：`wecom/src/bot/event-handler.ts` + 子模块
- Stream 主流程：`wecom/src/bot/stream-agent.ts`
- Stream 子模块：`wecom/src/bot/stream-*.ts`
- 状态：`wecom/src/bot/state.ts`

## 共享模块

- webhook 加解密：`wecom/src/shared/webhook-crypto.ts`
- HTTP 工具：`wecom/src/shared/http-utils.ts`
- 字符串与错误：`wecom/src/shared/string-utils.ts`
- 媒体处理：`wecom/src/shared/media-*.ts`
- 会话队列：`wecom/src/shared/conversation-queue.ts`

## 核心设计原则

- 入口壳层化：入口文件只负责流程编排。
- 能力下沉：业务能力按职责拆分为独立模块。
- 行为优先：重构期间优先保持外部行为不变。
