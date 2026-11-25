# quick2api

把本地 **Amazon Quick（QuickWork）** 桌面端的聊天能力，转成 **Anthropic Messages API**，供 **Claude Code** 直接使用。

```
Claude Code ──Anthropic /v1/messages (SSE)──▶ quick2api ──Quick DataPlane WebSocket──▶ Amazon Quick
```

> 非官方项目，与 Amazon / AWS 无关联。请只在你拥有或获得明确授权的账号上使用，并遵守相关服务条款。
> 登录凭据保存在本机 `data/accounts.json`（权限 0600），不会上传到任何第三方。

---

## 1. 它解决什么问题

Claude Code 只会说 Anthropic Messages API，而 Amazon Quick 桌面端说的是自己的 WebSocket 双向协议（AIDP，AWS event-stream 帧）。本项目在本地起一个 HTTP 服务：

- 接收 `POST /v1/messages`（流式 / 非流式）
- 把 Anthropic 的 `system`、`messages`、`tools`、`tool_use`、`tool_result` 转换成 Quick 单轮 `user_message`
- 把 Quick 返回的文本、原生工具事件、`<client_tool_call>` 文本标记转回 Anthropic 的 `text` / `tool_use` 内容块
- 完成原生 OAuth（PKCE）登录、token 刷新、多账号轮询

Claude Code 里的工具（Read / Write / Edit / Bash / Grep / Glob …）仍然由 Claude Code 在本机执行；Quick 只负责“决定调用哪个工具、参数是什么”。

## 2. 与参考实现的差异

协议行为参考了 [jasonxu114514/aws-quickwork-2api](https://github.com/jasonxu114514/aws-quickwork-2api)（Go，GPLv3），本项目是独立的 Node.js 实现，没有包含其 Go 源码。

| | 参考项目 | 本项目 |
|---|---|---|
| 暴露协议 | OpenAI `/v1/chat/completions` | **Anthropic `/v1/messages`**（Claude Code 原生） |
| 运行时 | Go 单文件 + SQLite + 内嵌 WebUI | Node.js ≥ 22 + JSON 文件，无构建步骤 |
| 超过 64 KiB 的 system/tools | 裁剪中间内容 / 附件上传 | **分段预热（priming）**，按合法 JSON 分组发送工具 schema |
| 依赖 | gorilla/websocket、modernc sqlite | 仅 `ws` |
| 管理界面 | 有 | 无，全部走命令行 |

如果你需要 OpenAI 兼容接口或 WebUI，直接用参考项目更合适；如果你要的是“Claude Code 能直接用”，本项目的协议层更贴合。

## 3. 功能

- `POST /v1/messages`：Anthropic 流式 SSE 与非流式 JSON
- `POST /v1/messages/count_tokens`：粗略 token 估算（Claude Code 会调用）
- `GET /v1/models`、`GET /healthz`、`HEAD /api/hello`
- Anthropic `tools` → `<caller_tool_interface>` 文本协议；支持单轮多个工具调用、`tool_choice`、`disable_parallel_tool_use`
- 工具名容错：大小写、`functions.` / `tools.` 前缀、`mcp__server__tool` 后缀匹配
- 原生 OAuth 登录：social（IAM Identity Center）与 enterprise（OIDC）两种流程，PKCE + 本地回调
- 无公网回调端口的服务器登录：`--manual` 手动粘贴浏览器地址
- 多账号轮询、到期前自动 refresh、401/403 自动 refresh 后重试
- 会话复用：Claude Code 每轮重发完整 transcript，代理只把新增消息发给同一个 Quick thread
- 64 KiB 帧预算：system / tools 过大时先发 setup 轮预热，再发真正的用户消息
- 请求日志不打印 prompt 内容和 token，只打印字节数、账号、耗时、用量

## 4. 环境要求

- Node.js **≥ 22.2**（用到内置 `fetch`、`node:zlib` 的 `crc32`、ESM）
- 一个能正常登录 Amazon Quick 的账号（桌面端能打开即可）
- 可选：Claude Code CLI（`claude`）
- 不需要 Go、Python、官方桌面应用常驻，也不需要 outpost 进程

## 5. 快速开始

```bash
cd was-quick2api
npm install
# 如果 npm 报 ~/.npm 权限错误：npm install --cache ./.npm-cache

# 1) 登录 Quick（会打开浏览器）
npm run login
# 或：node bin/quick2api.mjs login

# 2) 可选：验证登录与上游 WebSocket（会发一条 "OK" 测试消息）
node bin/quick2api.mjs doctor

# 3) 启动反代
npm start
# 或：node bin/quick2api.mjs serve
```

默认监听 `127.0.0.1:8080`。另开一个终端：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_AUTH_TOKEN=local      # api_keys 为空时随便填；配置了就填对应 key
export ANTHROPIC_MODEL=claude-sonnet-4-5
claude
```

先验证一下：

```bash
curl http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: local' \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "stream": true,
    "system": "You are a concise assistant.",
    "messages": [{"role": "user", "content": "用三句话解释 QUIC"}]
  }'
```

首次运行会自动生成 `config.json` 和 `data/accounts.json`。

## 6. 登录详解

### 6.1 浏览器模式（本机）

```bash
node bin/quick2api.mjs login
```

流程：

1. 终端打印 discovery URL，例如
   `https://quick.aws.com/sn?qwSurface=desktop:<nonce>:18080:1.2.4757`
2. 浏览器完成 AWS 登录后跳到本地 `/callback`，代理据此注册 IAM Identity Center OIDC client（PKCE）
3. 浏览器继续跳到 `https://oidc.<region>.amazonaws.com/authorize`
4. 登录完成后回调 `http://127.0.0.1:18080/?code=...`，代理换取 token 并拉取用户信息
5. 写入 `data/accounts.json`

回调端口默认 `18080`，被占用时：

```bash
node bin/quick2api.mjs login --port 18081
```

### 6.2 服务器 / 远程登录（手动）

服务器上打不开本地回调端口时：

```bash
node bin/quick2api.mjs login --manual
```

按提示把浏览器地址栏里的**完整 URL** 粘贴回来：

1. 打开 discovery URL，登录后浏览器会跳到 `http://localhost:18080/callback?...`（可能打不开，正常），复制整个地址
2. 终端打印 authorize URL，继续在浏览器打开并登录
3. 浏览器跳到 `http://127.0.0.1:18080/?code=...`，再复制整个地址粘贴回终端

脚本化时也可以把 URL 从 stdin 管道输入。

### 6.3 企业 SSO

```bash
node bin/quick2api.mjs login --provider enterprise --region us-east-1
```

### 6.4 多账号

重复执行 `login` 即可。相同 `provider + email + tenant_url` 会更新原账号，不会重复插入。请求按轮询选择账号；会话复用时固定使用创建该 thread 的账号。运行中的服务会自动发现账号文件的变化，不必重启。

### 6.5 账号管理

```bash
node bin/quick2api.mjs accounts          # 列表（不打印 token）
node bin/quick2api.mjs accounts --json
node bin/quick2api.mjs refresh           # 立即刷新所有账号
```

## 7. 配置

首次运行生成的 `config.json` 与 [`config.example.json`](./config.example.json) 一致。

| 字段 | 默认 | 说明 |
|---|---|---|
| `addr` | `127.0.0.1:8080` | 监听地址 |
| `api_keys` | `[]` | 客户端 key；为空时接受任意 token（只适合本机） |
| `models` | `smart/fast/balanced/auto` | 透传给 Quick 的 `agent_mode` |
| `default_model` | `smart` | 无法映射时使用 |
| `model_map` | opus/sonnet→smart，haiku→fast | 按模型名子串映射 |
| `request_timeout` | `10m` | 单次请求总超时（含预热轮） |
| `refresh_before` | `10m` | token 到期前多久刷新 |
| `max_attempts` | `2` | 上游尝试次数（含换账号 / refresh 重试） |
| `app_version` | 自动检测 / `1.2.4757` | 握手 `appVersion`；新建配置时读取 macOS 已安装版本，失败则用常量 |
| `surface` | macOS: `QUICK_WORK_DESKTOP_MAC`，其他: `QUICK_WORK_DESKTOP_WINDOWS` | 握手 `surfaceType`；必须与运行平台一致，否则上游会误判平台 |
| `outpost_id` / `working_session_id` | 空 | 上游可选字段 |
| `timezone` | 系统时区 | `user_message.user_timezone` |
| `locale` | `en-US` | `user_message.user_locale` |
| `thinking_effort` | 空 | `off/low/medium/high`；空为服务端默认 |
| `chat_agent_id` | 空 | 指定 Quick 自定义 agent |
| `expose_native_tools` | `true` | 把 Quick 原生工具事件映射为 Anthropic `tool_use`；external-agent 模式下 Quick 会等待客户端执行，关闭会导致 95s 超时 |
| `session_reuse` | `true` | 同一对话复用上游 thread，只发增量 |
| `keep_sessions` | `false` | `session_reuse=false` 时是否保留每次新建的会话 |
| `session_ttl` | `30m` | 本地会话映射的闲置过期时间 |
| `max_frame_bytes` | `63488` | 单帧预算（上游上限 64 KiB） |
| `prime_chunk_bytes` | `49152` | 预热分段目标大小 |
| `accounts_file` | `data/accounts.json` | 账号文件，相对配置文件目录 |
| `log_level` | `info` | `debug/info/warn/error`，也可用 `QUICK2API_LOG` |

环境变量覆盖：

```bash
QUICK2API_CONFIG=/path/config.json
QUICK2API_ADDR=127.0.0.1:8090
QUICK2API_API_KEY=key1,key2
QUICK2API_APP_VERSION=1.2.4757
QUICK2API_LOG=debug
```

## 8. 工作原理

### 8.1 上游连接

登录后账号里保存 `ws_host`（tenant 域名）与 JWT（优先 ID token）。每个请求建立一条 WebSocket：

```
wss://<ws_host>/streaming/quickwork-chat-bidirectional-stream
  ?surfaceType=...&outpostId=...&token=<jwt>        # social 把 token 放 query
  Authorization: Bearer <jwt>
  Origin: file://
  X-Surface-Type / X-Outpost-Id / X-Agent-Service-Type: UNIFIED_QUICK
```

发送顺序：

1. `session_connect`（actor_id / surface / appVersion）
2. `federate_status`
3. 新会话时 `session_create`
4. 一到多个 `user_message`
5. 需要时 `session_delete`

AIDP 传输格式：出站是
`{"eventType":"rawInputEvent","payload":{"payload":"<base64(JSON)>"}}`，
入站是 AWS event-stream，body 为 `{"payload":"<base64(JSON)>"}`。Gateway 账号则走 CBOR + event-stream。

### 8.2 64 KiB 与“分段预热”

Quick 的单个 `user_message` 上限约 64 KiB。Claude Code 的请求通常是：

- system prompt ≈ 27 KB
- 12 个工具的 JSON Schema ≈ 46 KB
- 当前 transcript ≈ 10 KB+

合计远超 64 KiB。直接截断会丢工具定义，所以本项目这样做：

1. **system prompt** 作为第一个 setup 轮发送
2. **工具定义用紧凑 JSON 按完整对象分组**（`{"tools":[...]}`，每组都合法），不会把某个 schema 从中间切断
3. 如果“工具定义 + 工具协议 + 当前用户消息”能放进一帧（Claude Code 通常可以），就直接合并进最后一轮；放不下才把工具定义拆成额外 setup 轮
4. 最后的 `[User message]` 才是真正的用户消息；每个 setup 轮只要求模型回复 `ACK`

真实 Claude Code 2.1.325 + 12 个工具的实测：首轮被拆成 **2 轮** `27533 / 57905` 字节（system setup + 工具定义/协议/用户消息），模型 ACK 后进入工具调用；第二轮（工具结果）因为 `session_reuse` 只发送 **287 字节**增量。

> 代价：每个新会话的首轮会多出 1 次上游调用，可能更慢、消耗更多 Quick 额度，并会在 Quick 聊天列表里留下 setup 轮。这是 64 KiB 限制下的取舍。

单个工具结果特别大时也会被拆成“用户消息 part 1/N（先 ACK）… final part”，保证不超帧。

### 8.3 会话复用

Claude Code 每轮都会重发完整 messages。代理按以下维度把请求映射到本地 conversation：

```
hash(system + tools + 第一条 user 文本)    // 或 X-Conversation-Id / X-Thread-Id
```

本地记录已转发到上游的 messages 前缀、上游 `thread_id`、账号。下一轮如果：

- system/tools 未变
- 新 messages 的前缀与记录深度相等

则只把新增的 assistant / tool_result 消息渲染成文本，追加到同一个上游 thread。否则新建会话、重发完整 transcript（必要时重新预热）。

### 8.4 工具桥接

Anthropic 工具定义会被渲染成 `<caller_tool_interface>` 文本，要求模型输出：

```xml
<client_tool_call>{"name":"Bash","arguments":{"command":"ls"}}</client_tool_call>
```

代理解析标记（也兼容 `<tool_call>`、`<function_call>`、Markdown 代码块、裸 JSON、`functions.` 前缀），生成 Anthropic `tool_use` 块，`stop_reason: "tool_use"`。Claude Code 执行后把 `tool_result` 发回来，代理把它渲染成：

```
Tool result (call_id=..., name=Bash): <内容>
```

上游原生 `tool_*` 事件也会被读取；只有名称属于调用方工具集时才会暴露成 `tool_use`。

### 8.5 流式行为

为了保证工具标记不会先以普通文本流给 Claude Code，代理会**先缓冲整轮上游输出**，结束后再按 Anthropic SSE 事件下发：

```
message_start → content_block_start(text) → deltas → stop
              → content_block_start(tool_use) → input_json_delta → stop
              → message_delta(stop_reason) → message_stop
```

连接期间每 15 秒发送一行 SSE 注释 `: keep-alive`，避免中间代理断开。因此你会看到 Claude Code 长时间转圈，然后一次性出现结果——这是有意为之。

## 9. Claude Code 用法

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_AUTH_TOKEN=local
export ANTHROPIC_MODEL=claude-sonnet-4-5
claude
```

模型映射（可在 `model_map` 改）：

| Claude Code 发送 | Quick `agent_mode` |
|---|---|
| `claude-opus-*` | `smart` |
| `claude-sonnet-*` | `smart` |
| `claude-haiku-*` | `fast` |
| `smart` / `fast` / `balanced` / `auto` | 原样 |

Claude Code 的 `/model` 只是切换它发送的模型名；对上游来说就是换 `agent_mode`。

## 10. 命令参考

```bash
node bin/quick2api.mjs serve [--config config.json] [--addr 127.0.0.1:8080]
node bin/quick2api.mjs login [--provider social|enterprise] [--stage prod]
                            [--region us-east-1] [--port 18080]
                            [--manual] [--no-browser]
node bin/quick2api.mjs accounts [--json]
node bin/quick2api.mjs doctor
node bin/quick2api.mjs settings
node bin/quick2api.mjs refresh
node bin/quick2api.mjs --help
```

## 11. 测试

```bash
npm test
```

覆盖：

- AWS event-stream / CBOR / AIDP 编解码与错误帧
- Prompt 渲染、工具标记解析（标记 / 代码块 / 裸 JSON / 命名空间）
- 64 KiB 预热分段、工具 schema 合法 JSON 分组
- PKCE、discovery URL、client 注册、code 交换、用户信息、账号派生
- 用假上游跑完整 Anthropic 工具循环、会话复用、增量 287 字节
- **真实 Claude Code** 通过代理完成 `Bash` 工具循环（未安装 `claude` 时自动跳过；`QUICK2API_TEST_CLAUDE=0` 强制跳过）
- 真实 CLI `serve` 加载配置 / 账号、鉴权、SSE 输出

## 12. 故障排查

**登录端口被占用**

```bash
node bin/quick2api.mjs login --port 18081
```

**`no Quick account is logged in`**：先 `login`。

**上游 401 / WebSocket 握手 401**：token 过期。先 `refresh`；仍失败就重新 `login`。

**`upstream WebSocket dial failed`**

- 检查系统时间是否准确（PKCE / JWT 对时间敏感）
- 把 `config.json` 的 `app_version` 改成已安装版本：

  ```bash
  defaults read "/Applications/Amazon Quick.app/Contents/Info.plist" CFBundleShortVersionString
  ```

- 若上游拒绝 surface，可尝试 `"surface": "QUICK_WORK_DESKTOP_MAC"`

**Claude Code 一直转圈**：首轮可能在预热（通常 1 次额外上游调用）；看日志：

```bash
QUICK2API_LOG=debug node bin/quick2api.mjs serve
```

日志会打印 `turns=2 turn_bytes=27533,57905`、`resume=true`、`turn_bytes=287` 等。

**Quick 自称 AWS Quick、拒绝扮演 Claude Code / 拒绝改文件**

- **先开新会话**：旧的 transcript 里已经包含它的拒绝文本，继续同一个会话会不断被模仿。用 `/clear`，或退出后重新 `claude`。
- 确认 `config.json` 的 `surface` 与平台一致：macOS 用 `QUICK_WORK_DESKTOP_MAC`，Windows 用 `QUICK_WORK_DESKTOP_WINDOWS`。
- 不要问“你是谁 / 前面是谁改的”这类元问题；直接给具体任务，例如「用 Bash 运行 pwd，把输出告诉我」。
- quick2api 会在每轮加入 relay contract，并把 Claude Code 的 “You are a Claude agent…” 中性化；如果仍出现旧行为，检查服务是否已重启、是否还在旧会话。
- 原生工具调用现在会回传给 Claude Code；如果日志出现 `Client sent no frames for >95 seconds`，说明上游在等客户端工具结果，确认 `expose_native_tools` 没被改成 `false`。

**Claude Code 报 API Error / 空回复**：上游可能拒绝、超时或模型只输出了空白。日志里的 `error=` 是上游原始错误。

**响应很慢 / 超时**：`request_timeout` 默认 10 分钟；Claude Code 自身请求超时也是 10 分钟。长任务会占用整个超时窗口。

**不想在 Quick 聊天列表看到 setup 轮**：目前无法完全避免；可关闭 `session_reuse` 之外的选项没有帮助。每个新会话都会预热一次。

## 13. 限制

- 只支持文本与工具调用；图片 / PDF 仅以 `[image]` / `[document]` 占位，不会上传
- 不使用 Quick 的附件上传 / DLP 流程（参考项目有）
- 忽略 Anthropic 的 prompt caching 标记、`temperature`、`stop_sequences`、`max_tokens`
- 每个新会话首轮的预热会额外消耗 Quick 额度
- 上游是通用 agent，可能不严格遵循工具协议；本项目通过提示词、名称容错和原生工具事件尽量兜底
- 没有 WebUI / 数据库 / 账号用量统计
- 未在真实 AWS 账号上做自动化端到端测试（登录需要人工浏览器交互）；协议与登录流程按参考实现对齐

## 14. 安全

- `data/accounts.json` 含 access/refresh/id token，文件权限 `0600`，已被 `.gitignore`
- `config.json` 也可能含 `api_keys`，同样已忽略
- `api_keys` 为空时接受任意客户端 token，**只应在 loopback 使用**
- 不要把服务直接暴露到公网；需要远程访问时配置 `api_keys`，并放在 TLS + 访问控制之后
- 日志不打印 prompt、token 或工具参数

## 15. 目录

```
bin/quick2api.mjs        CLI 入口
src/config.mjs           配置加载 / 模型映射
src/accounts.mjs         账号 JSON 存储
src/oauth.mjs            PKCE 登录、刷新、用户信息
src/upstream.mjs         WebSocket 客户端、握手、事件读取
src/wire.mjs             AIDP / Gateway 编解码
src/eventstream.mjs      AWS event-stream 帧
src/cbor.mjs             Gateway CBOR
src/translate.mjs        Anthropic → 文本 prompt、工具桥、预热规划
src/conversations.mjs    会话复用 / 增量
src/server.mjs           /v1/messages、SSE、重试
scripts/install-service.mjs  macOS LaunchAgent 安装/卸载
scripts/claude-quick     用 --settings 直连 quick2api 的启动脚本
test/                    mock 上游与测试
```

## 16. 与 CC Switch 结合：直连最佳实践

可以，而且不用改 CC Switch 的配置。关键在于：CC Switch 会把 `~/.claude/settings.json` 的 `ANTHROPIC_BASE_URL` 写成 `http://127.0.0.1:15721`。**只在终端 `export ANTHROPIC_BASE_URL` 不够**——实测它会被 settings.json 里的值覆盖；`claude --settings <文件>` 才能稳定覆盖（Claude Code 2.1.325 验证，`--settings` 同时优先于 settings.json 和进程环境变量）。

> **只想省事**：直接在 CC Switch 里加一张卡、保持本地路由（见 16.3），不用 `--settings`、不用改 shell；代价是多一跳 `15721`，长任务把 CC Switch 的空闲超时调到 `600s`。想完全不让 CC Switch 介入、或经常跑长任务，再用 16.1 的 `claude-quick`。

### 16.1 最佳方式：`claude-quick` 专用启动（推荐）

普通 `claude` 继续走 CC Switch，只有 `claude-quick` 直连 quick2api。互不干扰，随时回退。

1. 启动 quick2api（建议用常驻方式，见 16.2）：

   ```bash
   npm start
   node bin/quick2api.mjs doctor   # 另开终端验证上游
   ```

2. 生成 Claude Code 的 `--settings` 文件：

   ```bash
   node bin/quick2api.mjs settings > ~/.claude/quick2api.settings.json
   ```

3. 在 `~/.zshrc` 里加一个函数：

   ```bash
   claude-quick() {
     command claude --settings "$HOME/.claude/quick2api.settings.json" "$@"
   }
   ```

   或者直接用仓库里的脚本：

   ```bash
   /path/to/was-quick2api/scripts/claude-quick
   ```

4. 新开终端：

   ```bash
   claude-quick
   ```

此时 `~/.claude/settings.json` 仍然是 CC Switch 的 `15721`，没有被修改；普通 `claude` 继续用 CC Switch 当前供应商，`claude-quick` 走 `8080 → Amazon Quick`。

> 不要用 `export ANTHROPIC_BASE_URL=...` 的方式做直连：会被 settings.json 覆盖。`--settings` 才是可靠的按次覆盖。

### 16.2 让直连常驻：macOS LaunchAgent

直连时 Claude Code 会直接连 `127.0.0.1:8080`，quick2api 必须一直在跑：

```bash
node scripts/install-service.mjs --dry-run   # 只看生成的 plist
node scripts/install-service.mjs install     # 安装并启动，开机自启，退出自动拉起
node scripts/install-service.mjs status
curl http://127.0.0.1:8080/healthz
```

- plist：`~/Library/LaunchAgents/io.github.quick2api.plist`
- 日志：`~/Library/Logs/quick2api.log`、`quick2api.err.log`
- 升级 Node 后路径会变，重新执行一次 `install`
- 卸载：`node scripts/install-service.mjs uninstall`

### 16.3 备选：CC Switch 里做成直连卡

如果你希望“在 CC Switch 里点一下就切到 Quick”，也可以：

1. CC Switch → Claude Code → `+` → **自定义配置**
2. 名称 `Amazon Quick (quick2api)`，Base URL `http://127.0.0.1:8080`（**不要加 `/v1`**），Token `local`（或 `config.json` 的 `api_keys[0]`）
3. 如果界面支持设置 JSON，粘贴 `node bin/quick2api.mjs ccswitch` 的输出
4. 把 Claude Code 从“本地路由”切回 **直连**，再选这张卡
5. 确认 `~/.claude/settings.json` 里是 `http://127.0.0.1:8080` 而不是 `15721`

注意：这会改变 Claude Code 的全局模式；切回本地路由后，Quick 也会走 `15721` 中转。

### 16.4 备选：保留 CC Switch 本地路由 / failover

链路：

```
Claude Code → CC Switch 127.0.0.1:15721 → quick2api 127.0.0.1:8080 → Amazon Quick
```

- 供应商“上游格式”选 **Anthropic Messages**（不要选 OpenAI / Gemini）
- Base URL 仍填 `http://127.0.0.1:8080`，不要加 `/v1`
- CC Switch 本地路由模式下，`~/.claude/settings.json` 里的 `PROXY_MANAGED` + `15721` 是正常的
- **超时**：quick2api 先缓冲整轮再下发内容；你当前 CC Switch 的 `streaming_first_byte_timeout=90s`、`streaming_idle_timeout=180s`。长任务可能超时，在 CC Switch 代理设置里把空闲超时调到 `600s`，或改用 16.1 直连
- CC Switch 可能把模型重写成 `claude-fable-5` 之类；quick2api 按 `sonnet` / `opus` / `haiku` 子串映射，未知模型走 `default_model`

### 16.5 注意事项

- quick2api 默认 `8080`，CC Switch 本地路由默认 `15721`，不要冲突
- CC Switch 只写配置，**不会启动 quick2api**；用 16.2 的 launchd 或 `nohup node bin/quick2api.mjs serve > quick2api.log 2>&1 &`
- `api_keys` 非空时，`--settings` 文件或 CC Switch 卡片里的 Token 必须与之一致
- 建议保留 `CLAUDE_CODE_AUTO_MODE_SERVER=0`：第三方端点无法通过 Claude Code 官方的 auto mode 服务端检查
- 不要把 Base URL 写成 `http://127.0.0.1:8080/v1`，否则请求会变成 `/v1/v1/messages`
- 如果你说的是命令行版 `ccswitch`（`huangdijia/ccswitch` 或 `@supertiny99/cc-switch`），原理相同：新增 Anthropic 兼容 profile，Base URL 填 `http://127.0.0.1:8080`，Token 填 `local`，具体命令以其 README 为准

## 17. 致谢与许可## 17. 致谢与许可

- 协议与登录流程参考 [jasonxu114514/aws-quickwork-2api](https://github.com/jasonxu114514/aws-quickwork-2api)（GPLv3）；本项目为独立 Node 实现，未包含其 Go 源码。
- 本项目沿用仓库根目录的 MIT License（见 [`LICENSE`](./LICENSE)）。
- Amazon Quick / AWS 是其各自所有者的商标；本项目与它们无关联。
