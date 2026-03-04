# OpenClaw WeCom Plugin (Dual Mode)

English | [中文](README.zh.md)

OpenClaw WeCom plugin supporting **Bot API mode** and **Internal App mode** with multi-account, media, and group chat.  
Current behavior is **model-first**: both Bot/App text flows go directly to OpenClaw Agent (no local text shortcut routing).

## Features
- Dual mode: Bot API (JSON callback + stream) / App (XML callback + ACK + proactive send)
- Multi-account: `channels.wecom.accounts`
- Standard callback routes: `/plugins/wecom/bot/{accountId}` and `/plugins/wecom/agent/{accountId}` (legacy `/wecom/*` also supported)
- Message types: text / image / voice / video / file (send & receive)
- Unified model-driven text handling for both Bot and App
- Stability: signature verification, AES decrypt, token cache, rate limit & retries
- Group chat: uses `appchat/send` when `chatId` is present
- Advanced: send queue, operation logs, media auto recognition

## Installation

### npm (Recommended)
```bash
openclaw plugins install @marshulll/openclaw-wecom
openclaw plugins enable openclaw-wecom
openclaw gateway restart
```
> The npm package **bundles dependencies** (no extra `npm install` on the server).
>
> Upgrade safety: during `postinstall`, the plugin prunes known legacy code files left by overlay/dirty upgrades (inside plugin directory only). It does **not** modify your Bot/App config files (for example `~/.openclaw/openclaw.json`).

### Local Path
```bash
openclaw plugins install --link /path/to/openclaw-wecom
openclaw plugins enable openclaw-wecom
openclaw gateway restart
```
> For local path installs, run `npm install` in the project directory first.

## Configuration

Write config to `~/.openclaw/openclaw.json`

- Minimal example: `docs/wecom.config.example.json`
- Full example: `docs/wecom.config.full.example.jsonc` (with comments)

> Recommendation: use account-scoped callback paths (for example `/plugins/wecom/bot/bot` and `/plugins/wecom/agent/app`) for clearer routing/debugging.

### Config Example (Dual Mode)
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

Both nested `bot/agent` blocks and legacy flat fields (`token`, `corpId`, etc.) are supported.

### Key Fields
| Field | Description |
|-------|-------------|
| `receiveId` | Bot mode: **Bot ID (aibotid)** for callback crypto validation |
| `corpId` | App mode: Corp ID for callback decryption and API calls |
| `agentId` | App mode: Agent ID (integer) |

### Mode Options
- `mode: "bot"`: Bot API only
- `mode: "app"`: App only
- `mode: "both"`: both modes (default)

## Webhook Setup (WeCom Admin)

Both modes require **public HTTPS**. Restart OpenClaw gateway after configuration.

### Bot Mode
- URL: `https://your-domain/plugins/wecom/bot/{accountId}`
- Token / EncodingAESKey: generated in admin, map to `token` / `encodingAESKey`
- Bot ID (aibotid): map to `receiveId`

### App Mode
- URL: `https://your-domain/plugins/wecom/agent/{accountId}`
- Token / EncodingAESKey: generated in admin, map to `callbackToken` / `callbackAesKey`
- CorpID / AgentID / Secret: map to `corpId` / `agentId` / `corpSecret`

## Gateway & Control UI Compatibility

- The plugin does **not** modify `gateway.controlUi` automatically.
- Keep `gateway.controlUi.enabled=true` to preserve OpenClaw Web Control UI access.
- For LAN access, include your real origin in `gateway.controlUi.allowedOrigins` (for example `http://192.168.1.228:18789`).
- If an old OpenClaw build occasionally intercepts webhook POST (HTTP 405), **upgrade OpenClaw first**; disable Control UI only as a temporary fallback while debugging.

Example:

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

## Media Handling

### Inbound Media
- **App mode**: downloads media to local temp dir (configurable via `media.tempDir`)
- **Bot mode**: if webhook provides media URL, decrypts with `encodingAESKey` and saves locally

### Outbound Media
- **Requires App credentials** (`corpId/corpSecret/agentId`) to send media
- Bot mode media bridge: when reply payload contains `mediaUrl + mediaType`, auto uploads and sends

### Image Recognition
Two recognition methods supported:

1. **Model vision input (default)**: let the model see the image directly
   - Requires model's `input` to include `"image"` in `~/.openclaw/openclaw.json`

2. **Plugin built-in vision (optional)**: enable `channels.wecom.media.vision.enabled=true`
   - Plugin generates recognition result first, falls back to model vision on failure

### Video Recognition
- Requires **ffmpeg** installation
- Enable: `media.auto.video.enabled=true`
- Modes: `light` (default, extract few frames) / `full` (extract frames at intervals)

```bash
# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y ffmpeg

# macOS
brew install ffmpeg
```

## Semantic Handling (Current)

- Bot text: directly sent to OpenClaw Agent.
- App text: directly sent to OpenClaw Agent.
- Removed local text shortcuts such as `/help`, `/status`, `/clear`, `/sendfile`, and local “send N messages/file-search” parsing.

### Agent File Send/Receive (App Mode)

Let Agent send files via `message` tool (e.g., "send me the file on desktop").

**Prerequisites**:

1. App mode credentials must be configured
2. Tool permissions enabled (see "OpenClaw Tool Permissions" below)

**Supported Media Types**:

| Type | Extensions | Size Limit |
|------|------------|------------|
| Image | `.jpg` `.jpeg` `.png` `.gif` `.bmp` `.webp` | 10MB |
| Voice | `.amr` `.mp3` `.wav` `.m4a` `.ogg` | 2MB |
| Video | `.mp4` `.mov` `.avi` `.mkv` `.webm` | 10MB |
| File | All other extensions | 20MB |

## Proactive Push (App Mode)

Endpoint path: `{webhookPath}/push` (e.g. `/plugins/wecom/agent/app/push`)

```bash
curl -X POST "https://your-domain/plugins/wecom/agent/app/push" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PUSH_TOKEN" \
  -d '{"toUser":"WenShuJun","text":"Hello"}'
```

| Parameter | Description |
|-----------|-------------|
| `toUser` | Target user ID |
| `chatId` | Target group ID (mutually exclusive with toUser) |
| `toParty` | Department IDs (`1|2` or array) |
| `toTag` | Tag IDs (`3|4` or array) |
| `text` | Text content |
| `mediaUrl` | Media URL (can be sent with text) |

## Bot Stream Final Reply Notes

- Bot mode usually returns an initial stream ACK (often shown as a "thinking..." placeholder).
- After the agent finishes, the plugin emits final content and can automatically push final output via `response_url` when needed, reducing cases where only placeholder text is shown.
- If you still only see placeholder text, check:
  - Bot callback reachability from WeCom;
  - Whether stream refresh callbacks are triggered;
  - Gateway logs for `bot final reply pushed via response_url` or related errors.

## Unified Outbound (CLI)

Send messages via OpenClaw CLI:
```bash
openclaw send --channel wecom --to WenShuJun "Hello"
openclaw send --channel wecom --to chat:CHAT_ID "Group test"
```

## OpenClaw Tool Permissions

To allow Agent to execute local commands (view files, run scripts, etc.), enable elevated permissions.

Add to `~/.openclaw/openclaw.json`:

```json
{
  "tools": {
    "elevated": {
      "enabled": true,
      "allowFrom": {
        "wecom": ["*"]
      }
    }
  }
}
```

> **Note**: `"*"` allows all users to use elevated features. For production, restrict to specific user IDs: `["user_id_1", "user_id_2"]`

Restart Gateway after configuration:
```bash
openclaw gateway restart
```

Verify configuration (send in WeCom):

- "Show me what files are in the current directory"
- "Run ls -la command"

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Callback verification failed | Check Token / AESKey / URL consistency |
| No reply | Ensure plugin enabled and gateway restarted |
| Bot stuck at "thinking..." | Check `response_url` availability and stream final push logs |
| Web Control UI not accessible | Check `gateway.controlUi.enabled` and `allowedOrigins`; do not disable Control UI long-term |
| Media too large | Adjust `media.maxBytes` or send smaller files |
| invalid access_token | Verify `corpId/corpSecret/agentId` |
| Agent cannot execute commands | Check `tools` config and allowlist |
| `errcode=60020` | WeCom IP whitelist issue, add server egress IP (`curl -s https://ipinfo.io/ip`) |

## Documentation
- Dev docs: `docs/TECHNICAL.md`
- Config examples: `docs/wecom.config.example.json` / `docs/wecom.config.full.example.jsonc`
- Testing checklist: `docs/TESTING.md`
