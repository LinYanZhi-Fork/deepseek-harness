# Agent Note: pi-ai 的 content: null 请求级修复

Status: implemented

[English](2026-09-02-pi-ai-null-content-onpayload-fix.md) | 中文

## 问题

pi-ai `openai-completions` 适配器将只含 tool_calls 的 assistant 轮次序列化为
`content: null`。严格的 OpenAI 兼容网关把 `content` 字段校验为字符串，
遇到 `null` 会拒绝请求并返回 422。DeepSeek Harness 自身的 LLM 适配层
（`dsh-llm-pi-ai`）通过 `streamSimple` 调用 pi-ai，因此继承了该行为；
在 workbuddy / qclaw 等严格网关后面，每轮工具调用后的下一步请求都会失败。

该 bug 存在于 pi-ai 0.84.4（npm latest）和 main 分支（第 887 行），
截至本文撰写时上游尚未修复。

## 决策

在 `dsh-llm-pi-ai` 的 `adapter.ts` 中，`streamSimple` 调用的选项里注册
`onPayload` 钩子（pi-ai 已声明的请求级回调，类型见 `SimpleStreamOptions`
→ `StreamOptions` → `ProviderRequestOptions.onPayload`）。该钩子遍历
即将发送的 wire payload 中的 `messages` 数组，把 `role === 'assistant'`、
`content === null` 且携带 `tool_calls` 的消息的 `content` 替换为空字符串。
返回 `undefined` 以保持原 payload 作为请求体。

payload 由 pi-ai 在 `buildParams` 中按请求构建，在 `onPayload` 调用后
不再被 pi-ai 修改，因此就地修改是安全的。

## 备选方案

**向 pi-ai 上游提交修复。** 不予采用作为首选路径，因为 pi-ai 是外部仓库（`@earendil-works/pi-ai`），审查周期不可控。dsh 侧的 `onPayload` 钩子是自包含的等价修复，不依赖上游修复时间线。上游修复后该钩子仍保持正确（`content: null` → `""` 是幂等操作）。

**在 `toPiContext` 转换层修改消息。** 不予采用，因为 `toPiContext` 生成的是 pi-ai 的 Context 格式，而 `content: null` 是 pi-ai 自身将 Context 转为 wire payload 时引入的，不是 dsh 能在 Context 层控制的。

**patch node_modules。** 临时使用但不可持续，`pnpm install` 会丢失。`onPayload` 钩子是持久化的源码级修复。

## 影响

每次 `streamSimple` 调用多执行一个 `onPayload` 回调，遍历 `params.messages` 数组。代价可忽略：消息数组已构建完成，回调只触碰携带 `tool_calls` 的 assistant 消息。该归一化对原生 OpenAI 端点不可见（`""` 与 `null` 等价），同时解除严格网关的阻塞。若上游 pi-ai 日后将 `content: null` 改为 `""`，该回调变为无操作（只匹配 `content === null`），移除它是清理而非行为变更。
