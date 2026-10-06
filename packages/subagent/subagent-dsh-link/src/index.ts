/**
 * Out-of-process HTTP subagent backend. Each child is a remote DeepSeek Harness
 * peer reachable over the dsh-link HTTP + Bearer + JSON protocol (typically
 * bridged through UU Remote port mapping for NATed setups), so it shares no
 * Cordis context with the parent. The provider advertises NO start-time
 * capabilities: a remote child cannot honor agentOptions/outputSchema/
 * maxDepth/toolFilter/persona (the service rejects a request needing any
 * before `start` runs). One provider instance binds one peer; routing across
 * multiple peers uses multiple named instances (see the [Agent Note on
 * product subagent providers](../../../.agents/notes/implemented/architecture/2026-08-10-product-subagent-providers-in-shared-host.md)).
 * This plugin uses named exports only; a default would hide its loader
 * metadata.
 * @module @deepseek-ai/dsh-subagent-dsh-link
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import { startHttpRun, type HttpRunSpec } from './run.ts'

export const name = 'subagent-dsh-link'
export const inject = ['subagents']

/** One peer reachable over dsh-link's HTTP + Bearer + JSON protocol. */
export interface PeerConfig {
  readonly name: string
  readonly url: string
  readonly token: string
}

/** Config: how to reach the remote dsh-link peer this provider drives. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `dsh-link`). */
  providerName: string
  /** The single remote peer this provider instance drives. */
  peer: PeerConfig
  /** Per-run HTTP request timeout in milliseconds (default 300000 = 5 min). */
  timeoutMs: number
  /** Maximum accepted response body in bytes (default 1 MiB; mirrors dsh-link's upgrade cap). */
  maxResponseBytes: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('dsh-link'),
  peer: z.object({
    name: z.string().required(),
    url: z.string().required(),
    token: z.string().default(''),
  }).required(),
  timeoutMs: z.number().min(1).default(300_000),
  maxResponseBytes: z.number().min(1).default(1 * 1024 * 1024),
})

/** Fixed safe failure text derived only from provider-owned structured facts. */
function failureDiagnostic(stage: 'initialize' | 'request' | 'response' | 'shutdown'): string {
  return `Subagent failure (provider: dsh-link; stage: ${stage}; category: unknown)`
}

/**
 * The HTTP subagent provider. It accepts only the bare start request and
 * derives the child's workspace from `request.parent` exactly the way the
 * other out-of-process backends do.
 */
class HttpSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    ...NO_START_CAPABILITIES,
  }
  // Context contract: a remote child starts fresh — no parent conversation
  // crosses the process boundary.
  readonly inheritsParentContext = false

  constructor(readonly name: string, private readonly ctx: Context, private readonly config: Config) {}

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const spec: HttpRunSpec = {
      peer: this.config.peer,
      timeoutMs: this.config.timeoutMs,
      maxResponseBytes: this.config.maxResponseBytes,
      onError: (error, stopReason) => {
        // The seam forbids `result` rejecting, so a child-level failure is
        // flattened to a stop reason — preserve it here rather than losing it.
        this.ctx.logger.warn(`subagent-dsh-link "${this.name}": child run failed (${stopReason}): ${error.message}`)
      },
    }
    return startHttpRun(request, spec, failureDiagnostic)
  }
}

export function apply(ctx: Context, config: Config): void {
  // Misconfiguration fails loud at load: every peer field is required, and
  // the URL must parse as absolute so the HTTP request cannot silently
  // re-anchor against a wrong host.
  const peerUrl = config.peer.url
  let parsed: URL
  try {
    parsed = new URL(peerUrl)
  } catch (cause) {
    throw new TypeError(`subagent-dsh-link "${config.providerName}": peer.url is not a valid URL: ${peerUrl}`, { cause })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`subagent-dsh-link "${config.providerName}": peer.url must use http or https, got ${parsed.protocol}`)
  }
  // Defensive: relative paths never serve as peer targets, even when the URL
  // parses; reject anything that isn't a fully-qualified URL.
  if (!isAbsolute(parsed.pathname) && parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new TypeError(`subagent-dsh-link "${config.providerName}": peer.url must be absolute, got ${peerUrl}`)
  }
  ctx.subagents.registerProvider(new HttpSubagentProvider(config.providerName, ctx, config))
}
