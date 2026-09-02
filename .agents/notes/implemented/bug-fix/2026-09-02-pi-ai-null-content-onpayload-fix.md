# Agent Note: Normalize pi-ai null assistant content via onPayload

Status: implemented

English | [中文](2026-09-02-pi-ai-null-content-onpayload-fix.zh.md)

## Problem

`@earendil-works/pi-ai` serializes an assistant turn that carries only `tool_calls` and no text with `content: null` on the OpenAI Chat Completions wire. The OpenAI API specification treats `content` as a string (or array of content parts), and strict OpenAI-compatible gateways validate `null` as a schema violation, rejecting the request with HTTP 422. Any harness provider routed through a strict gateway fails on every multi-turn conversation that includes a tool-call step, because the assistant turn replayed from history reaches the gateway with `content: null`.

## Decision

`dsh-llm-pi-ai` registers an `onPayload` callback on every `streamSimple` call in `adapter.ts`. The callback walks the finalized request `params.messages` and replaces `content: null` with `""` on assistant messages that carry `tool_calls`. The `onPayload` hook is a request-level callback pi-ai invokes after message conversion and before the HTTP request, so the normalization happens on the wire payload, not on the pi-ai Context model. The callback returns `undefined` to keep the mutated payload as the request body, matching the documented contract.

The fix is scoped to `dsh-llm-pi-ai` rather than the upstream `pi-ai` package because the upstream `content: null` value is intentional for native OpenAI endpoints (which accept `null`), and the normalization is only needed for strict gateways the harness targets. The upstream pi-ai bug (missing `content: ""` when `requiresAssistantAfterToolResult` is false) remains unaddressed in `0.84.4` and on the `main` branch.

A mock-server test constructs a multi-turn history with a tool-only assistant message and asserts the wire request body contains `content: ""` rather than `null` for that assistant turn.

## Alternatives considered

**Patch `node_modules` directly.** Rejected because `pnpm install` discards the patch on every lockfile resolution, making the fix non-durable.

**Fork and pin a patched `pi-ai`.** Rejected because the bug is a single wire-value normalization; maintaining a fork for one line outweighs the cost of a request-level callback the harness already has a hook for.

**Fix in `toPiContext` (context conversion).** Rejected because `toPiContext` produces the pi-ai `Context` model, where assistant content is an array of typed blocks; `content: null` is emitted later by pi-ai's `convertMessages`, after the Context leaves the harness boundary. Only `onPayload` sees the final wire payload.

**Wait for upstream `pi-ai` to fix it.** Rejected because the bug has been present since `0.84.2` (the version the harness depends on) and remains in `0.84.4` and on `main`; the harness cannot block tool-call conversations on an upstream timeline.

## Consequences

Every `streamSimple` request through `dsh-llm-pi-ai` now runs one extra `onPayload` callback that iterates `params.messages`. The cost is negligible: the message array is already built and the callback touches only assistant messages with `tool_calls`. The normalization is invisible to native OpenAI endpoints (which accept `""` interchangeably with `null`) and unblocks strict gateways. If upstream `pi-ai` later fixes `content: null` to `""`, the callback becomes a no-op (it only matches `content === null`), so removing it is a cleanup, not a behavior change.
