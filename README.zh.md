# OpenClaw 企业微信插件（双模式）

中文 | [English](README.en.md)

一个同时支持企业微信 **Bot 模式** 和 **App 模式** 的 OpenClaw 插件。  
当前版本统一为**模型直连模式**：Bot/App 文本都直接进入 OpenClaw Agent，不再走本地命令分流。

## 你会得到什么

- 双模式并行：Bot（智能机器人回调）+ App（自建应用回调）
- 多账户支持：`channels.wecom.accounts`
- 标准回调路径：`/plugins/wecom/bot/{accountId}`、`/plugins/wecom/agent/{accountId}`（兼容旧 `/wecom/*`）
- 文本/图片/语音/视频/文件收发
- 统一模型驱动：Bot/App 文本都由 OpenClaw 模型处理
- 主动推送接口：`{webhookPath}/push`

## 5 分钟上手

### 1) 安装

```bash
openclaw plugins install @marshulll/openclaw-wecom
openclaw plugins enable openclaw-wecom
openclaw gateway restart
```

本插件 npm 包已内置依赖，服务端无需再手动 `npm install`。

> 升级安全说明：插件在 `postinstall` 会自动清理历史版本残留代码文件（仅插件目录内的已废弃文件），不会修改或清空你的 Bot/App 配置（如 `~/.openclaw/openclaw.json`）。

### 2) 写入最小配置

编辑 `~/.openclaw/openclaw.json`：

```json5
{
  "channels": {
    "wecom": {
      "enabled": true,
      "mode": "both",
      "defaultAccount": "bot",
      "accounts": {
        "bot": {
          "mode": "bot",
          "webhookPath": "/plugins/wecom/bot/bot",
          "bot": {
            "token": "BOT_TOKEN",
            "encodingAESKey": "BOT_AES",
            "receiveId": "BOT_ID"
          }
        },
        "app": {
          "mode": "app",
          "webhookPath": "/plugins/wecom/agent/app",
          "agent": {
            "corpId": "CORP_ID",
            "corpSecret": "CORP_SECRET",
            "agentId": 1000001,
            "callbackToken": "CALLBACK_TOKEN",
            "callbackAesKey": "CALLBACK_AES",
            "pushToken": "PUSH_TOKEN"
          }
        }
      }
    }
  }
}
```

建议 Bot 和 App 使用不同的 `webhookPath`，便于排障。
`bot/agent` 子对象和旧版平铺字段（如 `token`、`corpId`）可同时兼容。

### 3) 企业微信后台配置回调

| 模式 | 回调 URL | 凭据对应 |
|---|---|---|
| Bot | `https://你的域名/plugins/wecom/bot/{accountId}` | `token` / `encodingAESKey` / `receiveId(aibotid)` |
| App | `https://你的域名/plugins/wecom/agent/{accountId}` | `callbackToken` / `callbackAesKey` / `corpId` / `corpSecret` / `agentId` |

要求公网 HTTPS 可访问。

### 4) 重启并验证

```bash
openclaw gateway restart
```

然后在企业微信里各发一条消息验证：
- Bot 机器人对话发 `hi`
- App 会话发 `hello`

## 常用能力

### 主动推送（App 模式）

接口：`{webhookPath}/push`（例：`/plugins/wecom/agent/app/push`）

```bash
curl -X POST "https://你的域名/plugins/wecom/agent/app/push" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PUSH_TOKEN" \
  -d '{"toUser":"WenShuJun","text":"你好"}'
```

也支持部门/标签推送：

```bash
curl -X POST "https://你的域名/plugins/wecom/agent/app/push" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PUSH_TOKEN" \
  -d '{"toParty":"2|3","toTag":"18","text":"日报提醒"}'
```

## Bot 模式说明（避免“只看到思考中...”）

- Bot 会先返回一条 stream ACK（常见显示为“思考中...”）。
- Agent 完成后会继续返回终态内容。
- 插件内置了 `response_url` 终态补发兜底，降低“只有占位、没有最终文本”的概率。

## 语义处理说明（当前行为）

- Bot 文本：直接进入 OpenClaw Agent（模型决定如何执行）。
- App 文本：直接进入 OpenClaw Agent（模型决定如何执行）。
- 不再内置本地文本捷径（如 `/help` `/status` `/clear` `/sendfile`、`发 N 条消息`、自然语言发文件）。

如果仍异常，先查网关日志关键字：
- `bot reply acked`
- `bot final reply pushed via response_url`
- `response_url ... failed`

## 控制台兼容建议（重点）

- 插件不会自动修改 `gateway.controlUi`。
- 建议保持控制台开启：`gateway.controlUi.enabled=true`。
- 局域网访问时把你的来源地址加入 `allowedOrigins`，例如：

```json
{
  "gateway": {
    "controlUi": {
      "enabled": true,
      "allowedOrigins": [
        "http://localhost:18789",
        "http://127.0.0.1:18789",
        "http://192.168.1.228:18789"
      ]
    }
  }
}
```

如果遇到旧版 OpenClaw 与 webhook 的 405 兼容问题，优先升级 OpenClaw；关闭 Control UI 只作为临时排障手段。

## 常见问题（精简版）

| 问题 | 先检查什么 |
|---|---|
| 回调校验失败 | Token / AESKey / URL 是否与后台一致 |
| Bot/App 无回复 | 插件是否启用、gateway 是否重启 |
| Bot 只有“思考中...” | `response_url` 是否可用，日志是否有终态推送 |
| 控制台打不开 | `gateway.controlUi.enabled` 与 `allowedOrigins` |
| `invalid access_token` | `corpId/corpSecret/agentId` 是否正确 |
| `errcode=60020` | 企业微信 IP 白名单是否包含出口 IP |

查看出口 IP：

```bash
curl -s https://ipinfo.io/ip
```

## 进阶文档

- 配置示例：`docs/wecom.config.example.json`
- 全量配置：`docs/wecom.config.full.example.jsonc`
- 测试清单：`docs/TESTING.md`
- 技术文档：`docs/TECHNICAL.md`
