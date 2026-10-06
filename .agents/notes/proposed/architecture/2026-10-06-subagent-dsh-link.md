# Agent Note: `@deepseek-ai/dsh-subagent-dsh-link` — out-of-process HTTP backend for remote DeepSeek Harness peers

Status: proposed

English | [中文](2026-10-06-subagent-dsh-link.zh.md)

## Problem

The `subagent` capability seam offers four out-of-process providers today — [`subagent-dsh-sdk`](../../../../packages/subagent/subagent-dsh-sdk/README.md), [`subagent-acp`](../../../../packages/subagent/subagent-acp/README.md), [`subagent-claude-code`](../../../../packages/subagent/subagent-claude-code/README.md), and [`subagent-codex`](../../../../packages/subagent/subagent-codex/README.md) — each driving one child Harness runtime in its own process. Every shipped backend runs locally: the provider spawns a child harness subprocess on the same host, derives the working directory from the parent session's cwd, and lets the child settle through its own session. The `subagent-dsh-sdk` Dev Note already records the gap:

> **Local child processes only** — the resolved working directory is a local path; **a remote runtime would need its own backend**.

A user with two DeepSeek Harness hosts — one on the company PC, one on the home PC — can already delegate tasks between them with the standalone [`dsh-link`](https://github.com/LinYanZhi/dsh-link) plugin (HTTP + Bearer + JSON over a UU Remote TCP tunnel). That plugin works, but its surface is "call this tool and get one answer back", not "delegate to a subagent and stream its reasoning". The model sees the peer's final text only; the peer's tool calls, intermediate turns, and decision points are invisible to the delegating session. The user has to choose between two imperfect options: stay on the local SDK backend and accept that "remote" means "another machine on my desk", or stay on `dsh-link` and accept that the peer is a tool call, not a subagent.

The Provider / Consumer / Host split that the [subagent-provider-lifecycle note](../../implemented/architecture/2026-07-05-subagent-provider-lifecycle-events.md) and the [shared-host note](../../implemented/architecture/2026-08-10-product-subagent-providers-in-shared-host.md) describe is exactly the seam a third out-of-process backend belongs on. The existing seam contracts already permit a remote backend: `SubagentRun.localAgent` is `Agent | undefined`, the seam's types call out "or `undefined` for a remote run", and `inheritsParentContext: false` is the honest answer for a fresh remote child. What is missing is the transport.

## Proposal

Add a fifth out-of-process provider, `@deepseek-ai/dsh-subagent-dsh-link`, that drives one remote `dsh-link` peer (HTTP + Bearer + JSON) as a subagent. The provider is registered on `ctx.subagents` like every other backend; `dsh-tool-subagent` consumers derive their tool description from the new provider's `inheritsParentContext: false` and `capabilities` without any load-order change. The Host registry stays the single provider authority, and the [product-subagent-providers-in-shared-host note](../../implemented/architecture/2026-08-10-product-subagent-providers-in-shared-host.md) applies without amendment — a Bundle whose loader patch mounts a named instance is the same shape the new provider follows.

The implementation lands in three phases, each independently shippable and each closed by its own PR:

### Phase 1 — minimal fire-and-forget HTTP backend

- New package `packages/subagent/subagent-dsh-link/` (named exports, `name = 'subagent-dsh-link'`, `inject = ['subagents']`).
- `Config` declares a single `peers: { name, url, token }` lookup, a `providerName` (default `dsh-link`), and an `inheritsParentContext: false` flag.
- `start(request)` opens an HTTP `POST` to `peers[].url/` with the configured Bearer token and the request prompt as `{ task: <str> }`, then waits for `{ ok, output }` and folds the answer with the seam's `AssistantOutputFold` semantic. The seam-level `settleRunResult` + `subprocessRunHandle` machinery handles cancellation and quiescent disposal; the only transport-level addition is a `request.signal`-aware `req.destroy()` on cancellation.
- `SubagentRun.localAgent` is `undefined` — the seam's documented remote-run shape — and `inheritsParentContext: false` so the model-facing tool wording never lies.
- Loader-composition and unit tests use a small Node `http.createServer` fixture that impersonates `dsh-link`'s `POST /` endpoint. Keyless snapshots pin the success path, the rejection path (provider's `stopReason: 'error'`), and the `aborted` path.

### Phase 2 — stream child session events through a single HTTP `POST /stream` endpoint

- `dsh-link` adds a Server-Sent Events endpoint (`POST /stream`) and migrates its `runLocalHeadless` from `spawn dsh --profile headless <task>` to the same SDK client used by `subagent-dsh-sdk`. Each child `session.event` flows through SSE on the wire.
- `subagent-dsh-link` consumes the SSE stream, pushes every event into the seam's child-event fold, and lets the existing seam observe path replay the events through the parent session log. The user gets the peer's tool calls and reasoning, not just its final answer, without inventing a new event vocabulary.
- The `dsh-link` migration is itself a feature change; its Agent Note is tracked separately and cross-linked from this one.

### Phase 3 — bidirectional callback and multi-turn continuation

- `dsh-link` exposes an inbound `POST /callback` endpoint that the remote DSH child can hit when its prompt needs a fact only the delegating session owns (a workspace path, a piece of conversation history the parent summary did not preserve, or a tool the child lacks).
- `subagent-dsh-link` opens a long-lived SSE stream during a single delegation; child callbacks arrive over a parallel `POST /callback` channel, and the provider answers them with `request.parent.session`-derived facts. The HTTP round-trip replaces the in-process `ctx.get` access that the seam expects for in-process backends.
- Multi-turn continuation (`prepareContinuable`) re-uses the same SSE stream: a follow-up prompt is an HTTP `POST` that re-opens the stream for the new turn, so the parent's tool description can advertise the continuation capability honestly.

### Acceptance criteria

Phase 1 closes when, on a `master` build with both `subagent-dsh-link` and `dsh-link` installed:

- A loader-composition e2e that boots a real `cordis.yml` mounts the new provider and a `tool-subagent` row pointing at it. The provider's `name` and `inheritsParentContext` appear in the registered descriptor that `tool-subagent` derives.
- A unit test sends a known prompt through the provider against a `http.createServer` fixture impersonating `dsh-link`'s `POST /`; the seam's `SubagentResult` resolves with the peer's text as `output` and `stopReason: 'completed'`.
- A second unit test cancels the request before the fixture responds; the resolved `SubagentResult` carries `stopReason: 'aborted'`, no transport error escapes the seam, and `dispose()` is idempotent.
- A third unit test simulates `dsh-link` returning `{ ok: false, error: '...' }`; the seam's `SubagentResult` resolves with `stopReason: 'error'` and a fixed diagnostic — no peer's error string reaches the model-facing surface.

Phase 2 closes when, on the same setup with the migrated `dsh-link`:

- A loader-composition e2e runs a child DSH that issues a tool call; the parent session log records the child's `tool/code-dispatch-start` and `tool/code-dispatch` events with the same shape they would have for an in-process provider.
- A snapshot test pins the rendered parent transcript for one scripted multi-step child run; replay survives a model and provider version bump.

Phase 3 closes when:

- The remote child calls back through `dsh-link`'s `POST /callback`; the parent's response carries a parent-session-derived fact that did not exist in the prepended summary.
- `prepareContinuable` produces a child whose session is cold-resumed across a process restart; the parent's `remote_subagent_followup` (fork-native subagent tool) succeeds without a fresh cold start.

## Alternatives considered

- **Stay on `subagent-dsh-sdk` and run a child Harness locally, then call `dsh-link` from inside the child** — rejected because the user's actual goal is "the child IS the remote machine's harness", not "a local child that shells out to a remote machine". The proposed provider matches the seam's surface directly; this alternative only defers the same plumbing one layer deeper.
- **Add HTTP transport to `subagent-dsh-sdk` itself** — rejected because the SDK package's design ([`subagent-dsh-sdk/README.md`](../../../../packages/subagent/subagent-dsh-sdk/README.md) line 12) is "the same-process value boundary": the SDK client is the cross-process value boundary, and adding HTTP would conflate two distinct transports. A separate package keeps each transport single-purpose.
- **Forward `dsh-link`'s existing `POST /` from a fork subagent tool directly, without a provider** — rejected because the [shared-host note](../../implemented/architecture/2026-08-10-product-subagent-providers-in-shared-host.md) makes the provider registry the single authority for delegation semantics. A bare tool would silently duplicate that authority and force every consumer (the model-facing tool, the `tool-subagent-control` consumer, future session-query tooling) to learn a second path.
- **Make the remote child inherit parent context** — rejected because the remote child has its own session, model, and composition; it cannot honor a parent-enforced persona or tool filter at the framework level. The honest answer is `inheritsParentContext: false`, matching the ACP and SDK backends.
- **Wait for the upstream fork to add a remote-runtime backend** — rejected because the local-fork workflow (origin `LinYanZhi-Fork/deepseek-harness`, pre-release stance, capability-seam extension as a designed extension point) is exactly what the [shared-host note](../../implemented/architecture/2026-08-10-product-subagent-providers-in-shared-host.md) calls "a new product provider". The fork ships the backend; an upstream contribution is a follow-up.

## Risks

- **The provider extends a seam whose lifecycle events (`subagent/provider-added`/`-removed`) only know how to derive tool wording, not how to derive transport-level health**. A flaky remote peer can show up as a transient tool that fires and then times out. The seam's `tools/change` emit covers the lexical side; transport-level observability is a follow-up deferred to Phase 2 and is tracked in the `dsh-link` migration Agent Note rather than here.
- **Phase 1 is intentionally non-streaming**. The model sees the peer's final text only, the same surface `dsh-link` already exposes. A user who reads Phase 1 as "done" will not see the tool calls. The version comment in `package.json` will record this as the Phase 1 limitation, mirroring the `subagent-dsh-sdk` "Local child processes only" disclosure, and the README will point to Phase 2 explicitly.
- **The host-plane placement is shared with the existing product providers**. The [shared-host note](../../implemented/architecture/2026-08-10-product-subagent-providers-in-shared-host.md) requires a Profile-level opt-in; a user who installs `dsh-link` alone will not get the subagent backend. The README will state this and show the minimum `cordis.patch.yml` snippet that mounts both the plugin and the named provider instance.
- **Bidirectional callback in Phase 3 introduces a new trust boundary**. A remote child that can hit `POST /callback` could probe the parent session. The provider must answer only with facts the seam already derives for in-process backends, and the parent's `cordis.yml` must gate the callback URL behind the same Bearer token as the task endpoint. The Phase 3 PR carries its own risk section; this note does not lock the answer down early.
- **The pre-release stance** ("foundation over blast radius", "rename or repackage freely") applies to the new package — a future upstream contribution may rename it. Cross-references from `dsh-tool-subagent`, from the Loader snapshot, and from any consumer in `packages/subagent/tool-subagent-control` must be updated in the same change that renames; the rename-ledger note (`2026-08-11-repository-naming-contract-and-rename-ledger.md`) governs that bookkeeping.
