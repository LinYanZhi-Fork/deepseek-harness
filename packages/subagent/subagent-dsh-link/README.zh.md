---
description: "进程外 HTTP subagent 后端 —— 为需要通过 dsh-link 的 HTTP + Bearer + JSON 协议驱动远程 DeepSeek Harness peer 的委托场景提供。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-dsh-link

[English](README.md) | 中文

## Summary

`dsh-subagent-dsh-link` 把每次委托的 child 作为远程 DeepSeek Harness peer,通过 [`dsh-link`](https://github.com/LinYanZhi/dsh-link) 的 HTTP + Bearer + JSON 协议(典型场景下由 UU Remote 端口映射穿越 NAT)运行。它是 SDK 和 ACP backend 之外的第三个进程外 backend,与它们在传输和 child 契约上不同:child 是远端 Harness peer,有它自己的 DSH 实例、profile、session、model route、tools;Phase 1 父只能看到 child 的最终 assistant 文本或一个安全的错误 —— 中间的消息或 tool traffic 不穿越边界。一个 provider 实例绑定一个 peer;跨多个 peer 路由需要 host 的 `cordis.yml` 里有多个具名实例。在 child 必须跑在与父不同的 host、且双方已经通过 `dsh-link` 连通的场景下选它。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

当委托必须跑在与父不同 host、且父已经装好并配置好 `dsh-link` 时挂载本 provider。一个 provider 实例绑定一个 peer;多个 peer 需要多个具名实例(参见 [named-instance decision](../../../.agents/notes/implemented/feature/2026-08-18-product-subagent-named-instances.md))。

### When to choose it

当 child 必须住在与父不同的 host 上、且父已经有 `dsh-link` 安装并配置好时选这个 backend。当 child 必须共享父的 composition 或遵守父强制的非路由 capability 时,选 in-process backend(`subagent-spawn-in-process` / `subagent-fork-in-process`):本 provider 不接受任何 start-time capability,直接拒绝 agentOptions / outputSchema / depthLimit / toolFilter / persona,而不是悄悄忽略。当 child 是同一台 host 上的完整 Harness runtime 时,选 SDK 或 ACP backend。

provider 把每个 start-time capability 都声明为 `false`,`inheritsParentContext: false`,与 SDK 和 ACP backend 一致。`start()` 只用 `request.parent` 派生 prompt 和 signal;Phase 1 不传输其它任何东西。本 provider 上的 `dsh-tool-subagent` 部署把 `maxDepth: 'provider-managed'` —— child peer 拥有自己的递归预算。

### Configuration

| 字段 | 默认 | 含义 |
|---|---|---|
| `providerName` | `dsh-link` | 在 `ctx.subagents` 上的注册名 |
| `peer.name` | 必填 | 被绑定 peer 的标识符,在日志里出现 |
| `peer.url` | 必填 | dsh-link peer HTTP server 的绝对 `http(s)://` URL |
| `peer.token` | `''` | provider 发送的 Bearer token;空表示不带 Authorization 头 |
| `timeoutMs` | `300000` | 单次 HTTP 请求超时(毫秒,5 分钟) |
| `maxResponseBytes` | `1048576` | 接受的 response body 最大字节数(1 MiB) |

完整的 [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-dsh-link) 是每个已接受字段及其 JSDoc 的权威来源。

多个 peer 需要多个具名实例。Profile 同时挂载 `home` 和 `company` peer 时,每个连到自己的 `providerName`:

```yaml
- id: dsh-link
  name: '@deepseek-ai/dsh-link'
  config:
    peers:
      - name: home
        url: http://127.0.0.1:8123
        token: <SHARED_SECRET>
      - name: company
        url: http://127.0.0.1:8123
        token: <SHARED_SECRET>
    port: 8124
    token: <SHARED_SECRET>

- id: subagent-dsh-link-home
  name: '@deepseek-ai/dsh-subagent-dsh-link'
  config:
    providerName: dsh-link-home
    peer: { name: home, url: http://127.0.0.1:8123, token: <SHARED_SECRET> }

- id: subagent-dsh-link-company
  name: '@deepseek-ai/dsh-subagent-dsh-link'
  config:
    providerName: dsh-link-company
    peer: { name: company, url: http://127.0.0.1:8123, token: <SHARED_SECRET> }

- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config: { provider: dsh-link-home, toolName: subagent-home, maxDepth: 'provider-managed' }

- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config: { provider: dsh-link-company, toolName: subagent-company, maxDepth: 'provider-managed' }
```

### What you get

成功 run 返回 child 的最终 assistant 文本作为 result 输出。peer 的最后一次 `POST /` 响应映射到 seam 词汇表:`ok: true` resolve 成 `completed`;`ok: false` resolve 成 `error` 并带一个固定的 diagnostic;非 2xx HTTP 状态 resolve 成 `error`;HTTP 超时 resolve 成 `error`;父侧取消 resolve 成 `aborted`(`dispose` 幂等)。Phase 1 只返回 peer 的最终文本 —— 没有 tool call 或推理穿越 wire。

### Failure and recovery

已经 abort 的请求在路径解析前失败。HTTP 错误、解析失败、非 2xx 状态都通过 result settle,带 `stopReason: 'error'` 和一个固定 diagnostic;父的 `tool-subagent` consumer 在不展示原始 HTTP 消息的前提下展示 diagnostic。父 signal abort 后失败的请求 settle 成 `aborted`,而不是 `error`。Dispose 销毁 in-flight HTTP socket,幂等。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现细节 —— 点击展开</summary>

这一段解释 backend 如何到达远程 dsh-link peer,以及可观察行为从哪里来;完整契约见 [Use this package](#use-this-package)。

### Design concept

- **远程 peer,单次请求**。每个 run 向被绑定 peer URL 发一次 `POST /`,等一次响应。没有持久连接。
- **一个 provider 实例绑定一个 peer**。多个 peer 需要 host 的 `cordis.yml` 里有多个具名实例。
- **HTTP 请求是序列化边界**。同进程 subagent 值不重复防御性拷贝;wire 是验证 hostile input 的地方。

### Source map

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin 入口:config schema、加载时验证、provider 注册 |
| [`src/run.ts`](src/run.ts) | HTTP run 生命周期、response 提取、stop-reason 映射 |

### Run flow

start 在加载时验证被绑定 peer URL,拒绝任何非 http(s) scheme。每个请求把 prompt 的 `ContentBlock[]` 合并成 dsh-link peer 接受的单个 `task` 字符串,然后发一个带配置 Bearer token 和硬响应大小上限的 HTTP `POST`。取消通过 `req.destroy()` 拆掉 in-flight socket;result promise settle 成 `aborted`,不等 peer。Dispose 幂等。

### Stop-reason mapping

peer 的 `POST /` 响应映射到 [`src/run.ts`](src/run.ts) 里的共享 stop-reason 词汇表:`{ ok: true, output }` → `completed`;`{ ok: false, ... }` → `error` 并带固定 diagnostic;非 2xx → `error` 并带固定 diagnostic;abort → `aborted`。

### Process boundary

不 spawn 任何子进程。transport 是父的 `node:http` 请求打到 peer 的 dsh-link HTTP server;peer 然后通过它当前的 `runLocalHeadless` 路径 spawn 自己的 child Harness runtime。provider 不持有任何凭据,除了配置的 Bearer token;它看不到 child 的 `DEEPSEEK_API_KEY` 或任何其它 peer 内部密钥。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

当包级契约不够时读这些页面。它们把 backend 引导到它挂载的 seam 和它驱动的 wire。

- [Subagent subsystem](../../../docs/subsystems/subagent.md) —— 服务契约、provider 契约、终态 result 语义。
- [dsh-subagent seam](../subagent/README.md) —— 本 provider 注册到的 registry 和 start API。
- [dsh-subagent-dsh-sdk](../subagent-dsh-sdk/README.md) —— 通过 stdio JSON-RPC 的同级进程外 provider。
- [dsh-subagent-acp](../subagent-acp/README.md) —— 通过 Agent Client Protocol 的同级进程外 provider。
- [GitHub 上的 dsh-link](https://github.com/LinYanZhi/dsh-link) —— 本 backend 驱动的 wire 协议;Phase 2 将用 `POST /stream` 替换 `POST /`。
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-dsh-link) —— 每个已接受 config 字段及其源声明。

-----

<a id="model-experience"></a>
## Model Experience

### Child-agent request

#### What the model sees

child peer 把独立任务作为它的 user message 接收,加上它自己配置的 system prompt、tools 和全新 session。它收不到任何父对话。父的 tool call 不能选择 child provider、model、reasoning effort、output cap:每个 start-time capability 都是 `false`,因为 wire 只传输 task 文本。child 的 provider、model、tools 来自 peer 自己的配置。

#### Token effect

child 为一个独立的完整上下文和自己的 multi-step 历史付费。这些 token 永远不进入父的上下文。

#### KV Cache effect

独立于父请求缓存。peer 的 session 只能复用它自己 provider、model、composition、历史下的相同前缀;child steps 否则 append-only 增长。

### Parent tool result, indirectly

#### What the model sees

通过 `dsh-tool-subagent`,父只收到 child 的最终 assistant 文本(或失败时的固定 diagnostic)。父的 tool description 从 provider 的 `inheritsParentContext: false` 派生,从不宣传跨会话上下文。Phase 1 只返回 peer 的最终文本 —— 没有 tool call 或推理被流回父的 session log。

#### Token effect

父输入只增长最终 result 或 error,该增长是数据相关的,直到 compaction 前都保留。本 provider 不为父添加任何 schema。

#### KV Cache effect

Append-only;新可见内容跟随可复用的请求前缀,不会让现有 KV-cache 条目失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了这个 backend 在哪些场景下是不合适的,或需要特别运维。它们是当前包级约束,不是通用 backend 比较或任务待办。

- **Phase 1 故意不做流式**。模型只看到 peer 的最终文本,与 `dsh-link` 已经暴露的 surface 相同。把 Phase 1 当成"完成"的用户看不到 tool calls。Phase 2 在 `dsh-link` 上引入 `POST /stream` SSE 端点,并在本 provider 中加一个 SSE 消费路径,把单个 `POST /` 替换成事件流,父的 session log 可以重放。
- **一个 provider 实例绑定一个 peer**。多个 peer 需要 host 的 `cordis.yml` 里有多个具名实例;单个实例不能跨 peer 路由。named-instance decision([`2026-08-18-product-subagent-named-instances.md`](../../../.agents/notes/implemented/feature/2026-08-18-product-subagent-named-instances.md))管理本 provider 跟随的 registry 身份规则。
- **没有 start-time capability**。父不能通过 wire 选择 child provider、model、reasoning effort、output cap、persona、tool filter 或 depth cap;peer 自己的配置拥有那些选择。配置 peer 的 profile 和 `cordis.yml` 即可。
- **peer 的 transcript 留在 peer 侧**。父 log 只记录委托 tool call 和固定 result 字段;peer 的 `session.event` 流在 Phase 1 不桥接到父 log。Phase 2 用事件流桥替换这个限制。
- **取消是 socket 级别**。没有 wire-level cancel 发给 peer;父拆掉自己的 in-flight 请求。已经在跑 child run 的 peer 在 Phase 3 引入 callback 通道之前,不能通过本 provider 打断。

## Dev Note

<a id="dev-note"></a>

### Working context for maintainers — click to expand

本 Dev Note 是面向 maintainer 的工作上下文:未决问题和未定的方向。它明确非权威 —— 已交付行为和限制见上面几节和包代码。

- **Phase 2 wire 设计**。替换 `POST /stream` SSE 端点和事件映射进父 session log 仍在设计中。Phase 2 Agent Note 会与本 note 并列并从这里 cross-link。
- **Phase 3 callback 信任边界**。能 hit `POST /callback` 端点的远程 child 可能探测父 session。Phase 3 PR 自带 risk 段;本 note 不提前锁死答案。

**Runtime invariant:** 不发布 companion。Run 生命周期配对归 subagent seam 的 invariant 所有并受其校验;本 backend 自身的状态存在于 in-flight HTTP 请求里,超出本 context 的事件流之外。
