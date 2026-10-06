# Agent Note: `@deepseek-ai/dsh-subagent-dsh-link` —— 面向远程 DeepSeek Harness peer 的进程外 HTTP 后端

Status: proposed

[English](2026-10-06-subagent-dsh-link.md) | 中文

## Problem

`subagent` capability seam 当前提供四个进程外 provider —— [`subagent-dsh-sdk`](../../../../packages/subagent/subagent-dsh-sdk/README.md)、[`subagent-acp`](../../../../packages/subagent/subagent-acp/README.md)、[`subagent-claude-code`](../../../../packages/subagent/subagent-claude-code/README.md)、[`subagent-codex`](../../../../packages/subagent/subagent-codex/README.md) —— 每个 provider 在自己的进程里驱动一个 child Harness runtime。所有已交付的 backend 都只在本地运行：provider 在同一台 host 上 spawn child harness 子进程,从父会话的 cwd 派生 working directory,让 child 通过自己的 session 自然结束。`subagent-dsh-sdk` 的 Dev Note 已经明确记录了这个缺口:

> **Local child processes only** —— 解析出的 working directory 是本地路径;**a remote runtime would need its own backend**。

用户拥有两台 DeepSeek Harness host —— 公司 PC 一台,家里 PC 一台 —— 已经在用独立的 [`dsh-link`](https://github.com/LinYanZhi/dsh-link) 插件(HTTP + Bearer + JSON,通过 UU Remote TCP 隧道)做跨机任务委托。该插件可用,但它的 surface 是"调用这个工具然后拿一个结果回来",而不是"委托给一个 subagent 并流式观察它的推理过程"。模型只能看到 peer 的最终文本;peer 的 tool calls、中间 turn、决策点对委托会话都不可见。用户必须在两个不完美的选项之间二选一:留在本地 SDK backend 上,接受"remote"只是"我桌上的另一台机器";或者继续用 `dsh-link`,接受 peer 只是 tool call,不是 subagent。

[subagent-provider-lifecycle note](../../implemented/architecture/2026-07-05-subagent-provider-lifecycle-events.md) 和 [shared-host note](../../implemented/architecture/2026-08-10-product-subagent-providers-in-shared-host.md) 描述的 Provider / Consumer / Host 分层,正好就是第五个进程外 backend 应该接入的 seam。现有的 seam 契约已经允许一个 remote backend:`SubagentRun.localAgent` 是 `Agent | undefined`,seam 的 type 注释明说 "or `undefined` for a remote run",`inheritsParentContext: false` 是 fresh remote child 的诚实答案。缺的只是 transport。

## Proposal

新增第五个进程外 provider,`@deepseek-ai/dsh-subagent-dsh-link`,通过 HTTP + Bearer + JSON 驱动一个远程 `dsh-link` peer 作为 subagent。provider 在 `ctx.subagents` 上注册,跟其他 backend 一样;`dsh-tool-subagent` consumer 从新 provider 的 `inheritsParentContext: false` 和 `capabilities` 派生它的 tool description,**无需任何 load-order 改动**。Host registry 仍然是唯一的 provider 权威,[product-subagent-providers-in-shared-host note](../../implemented/architecture/2026-08-10-product-subagent-providers-in-shared-host.md) 适用而无需修订 —— 一个 Bundle 通过 loader patch mount 一个具名实例,新 provider 沿用同样的形态。

实现分三个 phase 落地,每个 phase 都可独立交付,由各自的 PR 关闭:

### Phase 1 —— 最小 fire-and-forget HTTP backend

- 新包 `packages/subagent/subagent-dsh-link/`(named exports,`name = 'subagent-dsh-link'`,`inject = ['subagents']`)。
- `Config` 声明一个 `peers: { name, url, token }` 查询表,一个 `providerName`(默认 `dsh-link`),以及 `inheritsParentContext: false`。
- `start(request)` 向 `peers[].url/` 发起 HTTP `POST`,带配置好的 Bearer token 和 request prompt 作为 `{ task: <str> }`,然后等待 `{ ok, output }` 并用 seam 的 `AssistantOutputFold` 语义折叠答案。seam 层的 `settleRunResult` + `subprocessRunHandle` 机制处理取消和 quiescent dispose;transport 层唯一新增的是 `request.signal` 感知的 `req.destroy()`。
- `SubagentRun.localAgent` 是 `undefined` —— seam 文档化的 remote-run 形态 —— `inheritsParentContext: false`,确保 model-facing tool wording 不撒谎。
- Loader-composition 和单元测试用一个小 Node `http.createServer` fixture 模拟 `dsh-link` 的 `POST /` 端点。Keyless snapshot 钉住成功路径、rejection 路径(provider 的 `stopReason: 'error'`)、`aborted` 路径。

### Phase 2 —— 通过单个 HTTP `POST /stream` 端点流式 child session events

- `dsh-link` 新增 Server-Sent Events 端点(`POST /stream`),把 `runLocalHeadless` 从 `spawn dsh --profile headless <task>` 迁移到 `subagent-dsh-sdk` 用的同一 SDK client。每个 child `session.event` 在 wire 上通过 SSE 流动。
- `subagent-dsh-link` 消费 SSE 流,把每个 event 推入 seam 的 child-event fold,让现有 seam observe 路径把 events 重放到父 session log。用户能看到 peer 的 tool calls 和推理,而不只是它的最终答案,无需发明新的 event vocabulary。
- `dsh-link` 迁移本身是一次 feature change;它的 Agent Note 单独跟踪,并从这里 cross-link。

### Phase 3 —— 双向 callback 和多 turn 续接

- `dsh-link` 暴露一个入站 `POST /callback` 端点,远程 DSH child 在它的 prompt 需要只有委托会话拥有的事实(workspace 路径、父 summary 没保留的对话历史、child 缺失的工具)时调用。
- `subagent-dsh-link` 在一次委托期间打开一个长生命周期 SSE 流;child callbacks 通过并行的 `POST /callback` 通道到达,provider 用 `request.parent.session` 派生的事实回答它们。HTTP 往返替代了 seam 对 in-process backend 期望的 `ctx.get` 访问。
- 多 turn 续接(`prepareContinuable`)复用同一个 SSE 流:后续 prompt 是一个重新打开流的 HTTP `POST`,所以父的 tool description 可以诚实地宣传续接 capability。

### Acceptance criteria

Phase 1 在满足以下条件时关闭 —— `master` build 同时装 `subagent-dsh-link` 和 `dsh-link`:

- 一个 loader-composition e2e 启动真 `cordis.yml`,挂载新 provider 和一个指向它的 `tool-subagent` 行。provider 的 `name` 和 `inheritsParentContext` 出现在 `tool-subagent` 派生的注册描述符里。
- 单元测试通过一个 `http.createServer` fixture 模拟 `dsh-link` 的 `POST /`,发送一个已知 prompt;seam 的 `SubagentResult` 以 peer 的文本作为 `output`、`stopReason: 'completed'` resolve。
- 第二个单元测试在 fixture 响应前取消请求;resolve 的 `SubagentResult` 携带 `stopReason: 'aborted'`,无 transport 错误逃出 seam,`dispose()` 幂等。
- 第三个单元测试模拟 `dsh-link` 返回 `{ ok: false, error: '...' }`;seam 的 `SubagentResult` 以 `stopReason: 'error'` 和一个固定 diagnostic resolve —— peer 的 error 字符串绝不接触 model-facing surface。

Phase 2 在迁移后的 `dsh-link` 上满足以下条件时关闭:

- 一个 loader-composition e2e 运行一个发起 tool call 的 child DSH;父 session log 用与 in-process provider 相同的 shape 记录 child 的 `tool/code-dispatch-start` 和 `tool/code-dispatch` events。
- 一个 snapshot test 钉住一个脚本化 multi-step child run 的渲染后父 transcript;replay 在 model 和 provider 版本升级后仍然存活。

Phase 3 在满足以下条件时关闭:

- 远程 child 通过 `dsh-link` 的 `POST /callback` 回调;父的响应携带一个父 session 派生的事实,而这个事实不存在于前置的 summary 里。
- `prepareContinuable` 生成一个 child,这个 child 的 session 在进程重启后被 cold-resume;父的 `remote_subagent_followup`(fork-native subagent tool)无需 fresh cold start 即可成功。

## Alternatives considered

- **停留在 `subagent-dsh-sdk`,在本地跑一个 child Harness,然后让 child 内部调用 `dsh-link`** —— 拒绝,因为用户的实际目标是"child 就是远程机器的 harness",而不是"本地 child 转一道手到远程机器"。提议的 provider 直接匹配 seam surface;这个替代方案只是把同样的 plumbing 推迟一层。
- **给 `subagent-dsh-sdk` 加 HTTP transport** —— 拒绝,因为 SDK 包的设计([`subagent-dsh-sdk/README.md`](../../../../packages/subagent/subagent-dsh-sdk/README.md) 第 12 行)是 "same-process value boundary":SDK client 是 cross-process value boundary,加 HTTP 会让两种不同的 transport 混在一起。独立包保持每个 transport 单一职责。
- **让 `dsh-link` 现有的 `POST /` 直接从一个 fork subagent tool 转发,不做 provider** —— 拒绝,因为 [shared-host note](../../implemented/architecture/2026-08-10-product-subagent-providers-in-shared-host.md) 让 provider registry 成为委托语义的唯一权威。一个裸 tool 会悄悄复制那个权威,迫使每个 consumer(model-facing tool、`tool-subagent-control` consumer、未来的 session-query tooling)学第二条路径。
- **让远程 child 继承父 context** —— 拒绝,因为远程 child 有自己的 session、model、composition;它无法在 framework 层面遵守父强制的 persona 或 tool filter。诚实的答案是 `inheritsParentContext: false`,与 ACP 和 SDK backend 一致。
- **等上游 fork 加一个 remote-runtime backend** —— 拒绝,因为 local-fork workflow(origin `LinYanZhi-Fork/deepseek-harness`,pre-release stance,capability-seam extension 作为设计扩展点)恰好就是 [shared-host note](../../implemented/architecture/2026-08-10-product-subagent-providers-in-shared-host.md) 所说的 "a new product provider"。fork 交付 backend;上游贡献是后续动作。

## Risks

- **provider 扩展了一个 seam,其 lifecycle events(`subagent/provider-added`/`-removed`)只知道派生 tool wording,不知道怎么派生 transport-level health**。一个不稳定的远程 peer 可能表现为一个触发后超时的瞬时 tool。seam 的 `tools/change` emit 处理词法层;transport-level 可观测性是 Phase 2 后续动作,在 `dsh-link` 迁移 Agent Note 里跟踪,而不是这里。
- **Phase 1 故意不做流式**。模型只看到 peer 的最终文本,与 `dsh-link` 已经暴露的 surface 相同。把 Phase 1 当作"完成"的用户不会看到 tool calls。`package.json` 里的版本注释会记录这个 Phase 1 限制,与 `subagent-dsh-sdk` "Local child processes only" 的披露方式对应,README 明确指向 Phase 2。
- **host-plane 装载与现有 product provider 共享**。[shared-host note](../../implemented/architecture/2026-08-10-product-subagent-providers-in-shared-host.md) 要求 Profile-level opt-in;只装 `dsh-link` 的用户拿不到 subagent backend。README 会说明这一点,并给出最小 `cordis.patch.yml` snippet 同时挂载插件和具名 provider 实例。
- **Phase 3 的双向 callback 引入新的信任边界**。能 hit `POST /callback` 的远程 child 可能探测父 session。provider 必须只回答 seam 已经为 in-process backend 派生过的事实,父的 `cordis.yml` 必须把 callback URL 与 task 端点用同一个 Bearer token 把守。Phase 3 PR 自带 risk 段;本 note 不提前锁死答案。
- **pre-release stance** ("foundation over blast radius"、"rename or repackage freely")适用于新包 —— 未来的上游贡献可能重命名它。从 `dsh-tool-subagent`、Loader snapshot、以及 `packages/subagent/tool-subagent-control` 里任何 consumer 的 cross-references 必须在同一次重命名改动中更新;rename-ledger note(`2026-08-11-repository-naming-contract-and-rename-ledger.md`)管理这一 bookkeeping。
