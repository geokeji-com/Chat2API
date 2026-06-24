# Windows Python Client Guide

本文档说明在 Windows 设备上运行 Chat2API 后，如何用 Python 脚本调用本机服务，以及当前可用的调用能力。示例优先参考项目内的 `scripts/call_ai_platform.py`，该脚本会把不同 AI 平台的响应整理成统一 JSON 结构。

## 前置条件

1. 在 Windows 上启动 `Chat2API.exe`。
2. 在应用里完成供应商账号配置，并启动代理服务。
3. 确认本机服务地址可访问，默认地址为：

```text
http://127.0.0.1:8080
```

OpenAI-compatible API base URL 是：

```text
http://127.0.0.1:8080/v1
```

如果应用里改过监听端口，把下面示例中的 `8080` 替换为实际端口。

## 可用 API

| API | 用途 |
| --- | --- |
| `GET /health` | 服务健康检查 |
| `GET /stats` | 代理服务统计信息 |
| `GET /v1/models` | 获取可用模型列表 |
| `GET /v1/models/{model}` | 获取指定模型信息 |
| `POST /v1/chat/completions` | OpenAI-compatible 聊天接口 |
| `POST /v1/completions` | OpenAI-compatible legacy completions 接口 |

管理 API 也可用，例如代理池节点、账号、日志等，但通常需要管理密钥：

```text
http://127.0.0.1:8080/v0/management
```

## 推荐方式：使用统一 Python 脚本

项目提供了测试/调用脚本：

```text
scripts/call_ai_platform.py
```

如果 Windows 设备上只有打包后的 `win-unpacked` 运行目录，需要从项目源码里单独复制这个脚本到 Windows 设备；打包程序本身不会内置 `scripts/` 目录。也可以不使用该脚本，直接按下文的 OpenAI-compatible API 示例自己写调用代码。

脚本只使用 Python 标准库，不需要额外安装依赖。建议使用 Python 3.10 或更新版本。

这个脚本只需要传入平台和查询内容，会自动：

- 构造 `/v1/chat/completions` 请求；
- 默认使用流式请求，并从最终 SSE 响应聚合为一个 JSON；
- 读取本次请求实际使用的代理 IP 和端口；
- 读取本次请求实际使用的 Chat2API 账号 ID 和供应商信息；
- 统一输出答案、引用、搜索词、分享链接、会话 ID 等字段；
- 支持城市代理、联网搜索、思考模式、原始调试日志。

### Windows 命令示例

在 PowerShell 中进入项目目录：

```powershell
cd C:\path\to\Chat2API
```

查看支持的平台：

```powershell
py scripts\call_ai_platform.py --list-platforms
```

调用 DeepSeek：

```powershell
py scripts\call_ai_platform.py --platform deepseek --query "你好，介绍一下你自己"
```

调用豆包：

```powershell
py scripts\call_ai_platform.py 豆包 "帮我总结一下今天的新闻"
```

指定本机服务地址：

```powershell
py scripts\call_ai_platform.py --base-url http://127.0.0.1:8080/v1 --platform qwen --query "写一个 Python 示例"
```

如果启用了 API Key：

```powershell
py scripts\call_ai_platform.py --api-key sk-xxxx --platform kimi --query "解释一下量子纠缠"
```

也可以通过环境变量配置：

```powershell
$env:CHAT2API_BASE_URL = "http://127.0.0.1:8080/v1"
$env:CHAT2API_API_KEY = "sk-xxxx"
py scripts\call_ai_platform.py --platform deepseek --query "你好"
```

## 平台与模型能力

脚本内置的平台别名如下：

| platformId | 中文名 | 默认模型 | 常用别名 |
| --- | --- | --- | --- |
| `doubao` | 豆包 | `doubao` | `豆包`, `doubao`, `Doubao` |
| `deepseek` | DeepSeek | `deepseek-v4-flash` | `deepseek`, `DeepSeek`, `深度求索`, `深度` |
| `yuanbao` | 元宝 | `hunyuan` | `元宝`, `腾讯元宝`, `yuanbao`, `Yuanbao` |
| `kimi` | Kimi | `Kimi-K2.6` | `kimi`, `Kimi`, `月之暗面` |
| `qwen` | 通义千问 | `Qwen3.7-千问` | `qwen`, `Qwen`, `千问`, `通义`, `通义千问` |

可用参数：

| 参数 | 说明 |
| --- | --- |
| `--platform` / 位置参数 | 选择平台，例如 `deepseek`、`豆包` |
| `--query` / 位置参数 | 用户问题 |
| `--model` | 覆盖默认模型 |
| `--system` | 添加 system prompt |
| `--web-search` | 启用联网搜索能力 |
| `--thinking` | 启用思考/推理模式；当前主要用于元宝模型名映射 |
| `--expert` | DeepSeek 专用，使用 expert/R1 模式 |
| `--city` | 请求指定城市的代理节点 |
| `--no-stream` | 使用非流式 JSON 请求 |
| `--raw` | 在最终输出中附带原始 OpenAI-compatible 响应 |
| `--no-debug-raw` | 关闭调试原始日志 |
| `--debug-log-file` | 指定调试日志路径 |
| `--main-task-id` | 指定输出中的任务 ID |
| `--enterprise-id` | 指定输出中的企业 ID |
| `--create-time` | 指定输出中的创建时间 |
| `--input-json` | 从 JSON 字符串、文件或 stdin 读取输入 |

## 代理字段

每次模型请求都会强制使用代理。脚本最终输出中会包含：

```json
{
  "proxy": {
    "ip": "203.0.113.10",
    "port": 1080,
    "address": "203.0.113.10:1080"
  }
}
```

说明：

- `proxy.ip` 和 `proxy.port` 是本次请求实际使用的代理出口。
- 用户名和密码不会出现在脚本输出中。
- 代理信息只来自 Chat2API 返回给本地调用方的响应头或响应体，不会写入上游 AI 平台请求。
- 如果响应中缺少代理信息，脚本会直接报错，不会静默输出空代理。

## 账号字段

脚本最终输出中会包含本次请求实际被负载均衡选中的账号：

```json
{
  "account": {
    "id": "account-1",
    "name": "采集账号 A",
    "providerId": "deepseek",
    "providerName": "DeepSeek"
  }
}
```

说明：

- `account.id` 是账号级限流、冷却和失败归因推荐使用的稳定字段。
- 账号 token、cookie、refresh token 等凭证不会出现在响应头、响应体或脚本输出中。
- 如果 Chat2API 已经选中账号后上游请求失败，脚本仍会输出结构化 JSON，并在 `account` 中保留账号信息，同时以非 0 退出码结束。
- 底层响应头为 `X-Chat2API-Account-Id`、`X-Chat2API-Account-Name`、`X-Chat2API-Provider-Id`、`X-Chat2API-Provider-Name`；脚本会自动解码账号名。

### 指定城市代理

如果希望请求尽量使用某个城市的代理节点：

```powershell
py scripts\call_ai_platform.py --platform deepseek --query "你好" --city 上海
```

如果提供了管理密钥，脚本会先检查代理池中是否存在可用的目标城市节点：

```powershell
$env:CHAT2API_MGMT_SECRET = "your-management-secret"
py scripts\call_ai_platform.py --platform deepseek --query "你好" --city 上海
```

输出中的城市字段含义：

| 字段 | 说明 |
| --- | --- |
| `city` | 调用方请求的城市 |
| `proxyCity` | 实际发送给 Chat2API 的城市约束 |
| `cityStatus` | 城市匹配状态 |

`cityStatus` 可能值：

| 值 | 含义 |
| --- | --- |
| `not_requested` | 没有指定城市 |
| `sent_unverified` | 未配置管理密钥，脚本未验证代理池，直接发送城市约束 |
| `matched` | 代理池中存在可用的目标城市节点 |
| `ignored_not_in_proxy_pool` | 代理池中没有可用的目标城市节点，脚本不发送城市约束 |

## 统一输出结构

脚本会输出一个 JSON 对象，常用字段如下：

| 字段 | 说明 |
| --- | --- |
| `mainTaskId` | 本次任务 ID，默认自动生成 UUID |
| `platform` | 平台中文名 |
| `platformId` | 平台 ID |
| `enterpriseId` | 企业 ID，可由参数传入 |
| `createTime` | 创建时间 |
| `query` | 原始问题 |
| `city` | 请求城市 |
| `proxyCity` | 发送给 Chat2API 的城市约束 |
| `cityStatus` | 城市代理匹配状态 |
| `model` | 使用的模型名 |
| `proxy` | 本次请求使用的代理 IP/端口 |
| `account` | 本次请求实际使用的 Chat2API 账号 |
| `answer` | 模型回答正文 |
| `reasoningContent` | 推理/思考内容 |
| `searchQueries` | 搜索查询词 |
| `relatedSearches` | 相关搜索 |
| `citations` | 引用来源 |
| `videos` | 视频结果 |
| `shareUrl` | 供应商分享链接 |
| `shareId` | 分享 ID |
| `conversationUrl` | 会话链接 |
| `sessionId` | 会话 ID |
| `userSnapshot` | 调试模式下提取的账号快照 |
| `proxySnapshot` | 保留的调试代理快照，不建议作为标准字段依赖 |
| `raw` | 使用 `--raw` 时附带原始响应 |

示例输出：

```json
{
  "mainTaskId": "7e31c11b-5f41-4d95-a61d-2f61a77a0d2e",
  "platform": "DeepSeek",
  "platformId": "deepseek",
  "createTime": "2026-06-18 14:00:00",
  "query": "你好",
  "city": "上海",
  "proxyCity": "上海",
  "cityStatus": "matched",
  "model": "deepseek-v4-flash",
  "proxy": {
    "ip": "203.0.113.10",
    "port": 1080,
    "address": "203.0.113.10:1080"
  },
  "account": {
    "id": "account-1",
    "name": "采集账号 A",
    "providerId": "deepseek",
    "providerName": "DeepSeek"
  },
  "answer": "你好！我是 DeepSeek...",
  "reasoningContent": "",
  "searchQueries": [],
  "relatedSearches": [],
  "citations": [],
  "videos": [],
  "shareUrl": "",
  "shareId": "",
  "conversationUrl": "",
  "sessionId": "",
  "userSnapshot": null,
  "proxySnapshot": null
}
```

## 通过 JSON 输入调用

适合从其他系统传入任务：

```powershell
py scripts\call_ai_platform.py --input-json '{"platform":"deepseek","query":"你好","city":"上海","enterpriseId":"ent-001"}'
```

从文件读取：

```powershell
py scripts\call_ai_platform.py --input-json "@C:\tasks\request.json"
```

`request.json` 示例：

```json
{
  "platform": "deepseek",
  "query": "请生成一段产品介绍",
  "city": "上海",
  "enterpriseId": "ent-001",
  "mainTaskId": "task-001",
  "createTime": "2026-06-18 14:00:00"
}
```

## 直接调用 OpenAI-compatible API

如果不需要统一输出结构，也可以直接使用 OpenAI SDK。

安装：

```powershell
py -m pip install openai
```

Python 示例：

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-xxxx",  # 未启用 API Key 时可以填任意非空字符串
    base_url="http://127.0.0.1:8080/v1",
)

response = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[
        {"role": "user", "content": "你好，介绍一下你自己"}
    ],
    extra_body={
        "proxy_city": "上海",
        "web_search": True
    }
)

print(response.choices[0].message.content)
```

如果你需要读取代理 IP/端口或本次实际使用的账号，建议使用 `scripts/call_ai_platform.py`；OpenAI SDK 通常不会暴露底层响应头，直接取 `X-Chat2API-Proxy-*` / `X-Chat2API-Account-*` 不方便。

## curl / PowerShell 调用

PowerShell 原生请求：

```powershell
$body = @{
  model = "deepseek-v4-flash"
  stream = $false
  messages = @(
    @{ role = "user"; content = "你好" }
  )
  proxy_city = "上海"
} | ConvertTo-Json -Depth 8

$response = Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8080/v1/chat/completions" `
  -ContentType "application/json" `
  -Body $body

$response
```

如果启用了 API Key：

```powershell
$headers = @{ Authorization = "Bearer sk-xxxx" }
Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8080/v1/chat/completions" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $body
```

## 调试日志

默认情况下，脚本会开启 raw debug，并把日志写入：

```text
logs/platform-calls/
```

关闭调试日志：

```powershell
py scripts\call_ai_platform.py --platform deepseek --query "你好" --no-debug-raw
```

指定日志路径：

```powershell
py scripts\call_ai_platform.py --platform deepseek --query "你好" --debug-log-file "C:\logs\deepseek-call.jsonl"
```

调试日志会对敏感字段做脱敏处理，但仍建议不要把日志公开分发。

## 常见问题

### 服务连接失败

确认 Chat2API 代理服务已经启动，并检查端口：

```powershell
Invoke-RestMethod http://127.0.0.1:8080/health
```

### 返回 `no_available_proxy`

当前模型请求必须使用代理。出现该错误通常表示：

- 代理池没有可用节点；
- 节点处于禁用、错误或冷却状态；
- 同一 AI 平台下其他账号已经占用了所有可用代理；
- 指定城市没有可用代理节点。

### 返回 `Missing proxy information in Chat2API response`

脚本要求响应中必须带代理元信息。如果出现该错误：

- 确认 Windows 上运行的是包含代理元信息改动的新版本；
- 确认请求走的是 Chat2API 本机服务，而不是其他 OpenAI-compatible 服务；
- 确认调用路径是 `/v1/chat/completions` 或 `/v1/completions`。

### 中文乱码

PowerShell 里可以先设置 UTF-8：

```powershell
chcp 65001
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8
```
