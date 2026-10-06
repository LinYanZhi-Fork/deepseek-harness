---
description: "The out-of-process HTTP subagent backend for users and maintainers choosing a delegation provider that drives a remote DeepSeek Harness peer reachable over dsh-link's HTTP + Bearer + JSON protocol."
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-dsh-link

English | [中文](README.zh.md)

## Summary

`dsh-subagent-dsh-link` runs each delegated child as a remote DeepSeek Harness peer reachable over the [`dsh-link`](https://github.com/LinYanZhi/dsh-link) HTTP + Bearer + JSON protocol (typically bridged through UU Remote port mapping for NATed setups). It is the third out-of-process backend beside the SDK and ACP providers, differing from them in the wire and the child contract: the child is a remote Harness peer with its own DSH instance, profile, session, model route, and tools; the parent only sees the child's final assistant text or a safe error — no intermediate messages or tool traffic crosses the boundary in Phase 1. One provider instance binds one peer; routing across multiple peers uses multiple named instances in the host's `cordis.yml`. Choose it when the child must run on a different host than the parent and the peers are already connected through `dsh-link`.

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

Mount this provider when a delegation should run on a remote DeepSeek Harness host that already speaks the `dsh-link` wire. One provider instance binds one peer; multiple peers require multiple named instances (see [named-instance decision](../../../.agents/notes/implemented/feature/2026-08-18-product-subagent-named-instances.md)).

### When to choose it

Choose this backend when the child must live on a host different from the parent's and the parent already has `dsh-link` installed and configured. Choose an in-process backend (`subagent-spawn-in-process` / `subagent-fork-in-process`) when the child must share the parent's composition or honor parent-enforced non-route capabilities: this provider accepts no start-time capabilities and rejects agentOptions / outputSchema / depthLimit / toolFilter / persona rather than silently omitting them. Choose the SDK or ACP backend when the child is a complete Harness runtime on the same host.

The provider advertises every start-time capability as `false` and `inheritsParentContext: false`, matching the SDK and ACP backends. `start()` uses only `request.parent` to derive the prompt and signal; nothing else crosses the wire in Phase 1. `dsh-tool-subagent` deployments over this provider set `maxDepth: 'provider-managed'` — the child peer owns its own recursion budget.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `providerName` | `dsh-link` | Registry name on `ctx.subagents` |
| `peer.name` | required | Identifier for the bound peer, surfaced in logs |
| `peer.url` | required | Absolute `http(s)://` URL of the dsh-link peer's HTTP server |
| `peer.token` | `''` | Bearer token the provider sends; empty means no Authorization header |
| `timeoutMs` | `300000` | Per-run HTTP request timeout in milliseconds (5 min) |
| `maxResponseBytes` | `1048576` | Maximum accepted response body in bytes (1 MiB) |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-dsh-link) is the exhaustive source for every accepted field and its JSDoc.

Multiple peers require multiple named instances. A Profile that mounts both a `home` and a `company` peer wires each to its own `providerName`:

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

A successful run returns the child's final assistant text as result output. The peer's last `POST /` reply maps into the seam vocabulary: `ok: true` resolves as `completed`, `ok: false` resolves as `error` with a fixed diagnostic, a non-2xx HTTP status resolves as `error`, an HTTP timeout resolves as `error`, and a parent-side cancellation resolves as `aborted` (idempotent on `dispose`). Phase 1 returns the peer's final text only — no tool calls or reasoning cross the wire.

### Failure and recovery

An already-aborted request fails before path resolution. An HTTP error, parse failure, or non-2xx status settles through the result with `stopReason: 'error'` and a fixed diagnostic; the parent's `tool-subagent` consumer presents the diagnostic without the raw HTTP message. A request that fails after the parent signal aborts settles as `aborted`, not `error`. Disposal destroys the in-flight HTTP socket and is idempotent.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the backend reaches a remote dsh-link peer and where the observable behavior comes from; the full contract lives in [Use this package](#use-this-package).

### Design concept

- **Remote peer, single request.** Each run issues one `POST /` against the bound peer URL and waits for one response. There is no persistent connection.
- **One provider instance binds one peer.** Multiple peers require multiple named instances in the host's `cordis.yml`.
- **The HTTP request is the serialization boundary.** Same-process subagent values are not defensively cloned; the wire is where hostile input is validated.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, load-time validation, provider registration |
| [`src/run.ts`](src/run.ts) | The HTTP run lifecycle, response extraction, and stop-reason mapping |

### Run flow

A start validates the bound peer URL at load and rejects any non-http(s) scheme. Each request coalesces the prompt's `ContentBlock[]` into a single `task` string the dsh-link peer accepts, then issues one HTTP `POST` with the configured Bearer token and a hard response-size cap. Cancellation tears down the in-flight socket via `req.destroy()`; the result promise settles as `aborted` without waiting for the peer. Disposal is idempotent.

### Stop-reason mapping

The peer's `POST /` reply maps into the shared stop-reason vocabulary in [`src/run.ts`](src/run.ts): `{ ok: true, output }` → `completed`; `{ ok: false, ... }` → `error` with fixed diagnostic; non-2xx → `error` with fixed diagnostic; abort → `aborted`.

### Process boundary

No subprocess is spawned. The transport is the parent's `node:http` request to the peer's dsh-link HTTP server; the peer then spawns its own child Harness runtime through its current `runLocalHeadless` path. The provider holds no credentials beyond the configured Bearer token; it does not see the child's `DEEPSEEK_API_KEY` or any other peer-internal secret.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from this backend to the seam it plugs into and the wire it drives.

- [Subagent subsystem](../../../docs/subsystems/subagent.md) — the service contract, provider contract, and terminal result semantics.
- [dsh-subagent seam](../subagent/README.md) — the registry and start API this provider registers on.
- [dsh-subagent-dsh-sdk](../subagent-dsh-sdk/README.md) — the sibling out-of-process provider over stdio JSON-RPC.
- [dsh-subagent-acp](../subagent-acp/README.md) — the sibling out-of-process provider over the Agent Client Protocol.
- [dsh-link on GitHub](https://github.com/LinYanZhi/dsh-link) — the wire protocol this backend drives; Phase 2 will replace `POST /` with `POST /stream`.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-subagent-dsh-link) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Child-agent request

#### What the model sees

The child peer receives the standalone task as its user message plus that peer's own configured system prompt, tools, and fresh session. It receives no parent conversation. A parent tool call may not choose the child provider, model, reasoning effort, or output cap: every start-time capability is `false` because the wire only carries the task text. The child's provider, model, and tools come from the peer's own configuration.

#### Token effect

The child pays for an independent full context and its own multi-step history. These tokens never enter the parent's context.

#### KV Cache effect

Independent of the parent request cache. The peer's session can reuse only prefixes identical under its own provider, model, composition, and history; child steps otherwise grow append-only.

### Parent tool result, indirectly

#### What the model sees

Through `dsh-tool-subagent`, the parent receives only the child's final assistant text (or a fixed diagnostic on failure). The parent's tool description, derived from the provider's `inheritsParentContext: false`, never advertises cross-session context. Phase 1 returns the peer's final text only — no tool calls or reasoning are streamed back to the parent's session log.

#### Token effect

Parent input grows only by the final result or error, which is data-dependent and retained until compaction. This provider adds no parent schema itself.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this backend is a poor fit or needs special operational care. They are current package constraints, not a general backend comparison or a task backlog.

- **Phase 1 is intentionally non-streaming.** The model sees the peer's final text only, the same surface `dsh-link` already exposes. A user who reads Phase 1 as "done" will not see the tool calls. Phase 2 introduces a `POST /stream` SSE endpoint on `dsh-link` and an SSE-consuming path in this provider, replacing the single `POST /` with an event stream the parent's session log can replay.
- **One provider instance binds one peer.** Multiple peers require multiple named instances in the host's `cordis.yml`; a single instance cannot route across them. The named-instance decision ([`2026-08-18-product-subagent-named-instances.md`](../../../.agents/notes/implemented/feature/2026-08-18-product-subagent-named-instances.md)) owns the registry identity rules this follows.
- **No start-time capabilities.** The parent cannot select the child provider, model, reasoning effort, output cap, persona, tool filter, or depth cap through the wire; the peer's own configuration owns those choices. Configure the peer's profile and `cordis.yml` instead.
- **The peer's transcript stays on the peer.** The parent log records only the delegation tool call and the fixed-result field; the peer's `session.event` stream is not bridged into the parent log in Phase 1. Phase 2 replaces this with an event-stream bridge.
- **Cancellation is socket-level.** No wire-level cancel is sent to the peer; the parent tears down its own in-flight request. A peer that has already begun a child run cannot be interrupted through this provider until Phase 3 introduces a callback channel.

## Dev Note

<a id="dev-note"></a>

### Working context for maintainers — click to expand

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the package code.

- **Phase 2 wire design.** The replacement `POST /stream` SSE endpoint and the event-mapping into the parent's session log are still being designed. The Phase 2 Agent Note will live alongside this one and cross-link from here.
- **Phase 3 callback trust boundary.** A remote child that can hit a `POST /callback` endpoint could probe the parent session. The Phase 3 PR carries its own risk section; this note does not lock the answer down early.

**Runtime invariant:** No companion is published. Run lifecycle pairing is owned and checked by the subagent seam's invariant; this backend's own state lives in the in-flight HTTP request beyond this context's event streams.
