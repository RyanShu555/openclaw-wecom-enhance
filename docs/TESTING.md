# OpenClaw WeCom 测试清单

## 基础检查

1. `npm run check`
2. `npm pack`

## App 模式

1. GET 回调验证（echostr）返回明文。
2. POST 文本消息可正常回复。
3. POST 图片/语音/视频/文件入站可识别。
4. `/push` 接口：
   - 正常 token 返回 `ok: true`
   - token 错误返回 403
   - body 超限返回 413

## Bot 模式

1. GET 回调验证（echostr）返回明文。
2. POST 文本消息返回 stream 占位并后续可刷新。
3. 重复回调触发 dedupe 命中。
4. 事件消息（`enter_chat` / `template_card_event`）分支正常。

## 双模式并行

1. 同时启用 `mode: both`。
2. App 与 Bot 分别使用不同 webhookPath。
3. 两条链路可同时收发，互不阻塞。
