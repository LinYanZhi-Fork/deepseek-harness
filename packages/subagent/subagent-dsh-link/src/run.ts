/**
 * Fresh-request HTTP subagent client. Drives one child session by POSTing the
 * task to the configured dsh-link peer's `POST /` endpoint over HTTP + Bearer,
 * and owns cancellation, the response cap, and quiescent disposal. Failure
 * modes map through the seam's stop-reason vocabulary with fixed safe
 * diagnostics; transport errors and child errors resolve through the result
 * promise rather than rejecting.
 *
 * [why]: the parent user wants to treat a remote DSH peer as an embedded
 *        subagent of the current session. Phase 1 ships the minimum that lets
 *        the model-facing tool surface work end-to-end: a single POST, a
 *        bounded response read, and a clean cancellation ladder. Phase 2
 *        replaces this with an SSE stream that pipes the peer's session
 *        events through the parent's session log.
 *
 * @module @deepseek-ai/dsh-subagent-dsh-link/run
 */

import { randomUUID } from 'node:crypto'
import { request as httpRequest, type ClientRequest } from 'node:http'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ResolvedSubagentStartRequest,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import { settleRunResult, subprocessRunHandle } from '@deepseek-ai/dsh-subagent'
import type { PeerConfig } from './index.ts'

/** Resolved spec for one HTTP subagent run. */
export interface HttpRunSpec {
  /** The remote peer the provider drives. */
  peer: PeerConfig
  /** Per-run HTTP request timeout in milliseconds. */
  timeoutMs: number
  /** Maximum accepted response body in bytes. */
  maxResponseBytes: number
  /** Host sink for transport or response failures; model-visible text uses fixed safe facts. */
  onError?: (error: Error, stopReason: SubagentStopReason) => void
}

/** Failure category names kept narrow so the diagnostic line stays fixed. */
type FailureStage = 'initialize' | 'request' | 'response' | 'shutdown'

/** A single text content block, matching the seam's text-only output selection. */
function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

/**
 * Coalesce one user prompt's content blocks into the single `task` string the
 * dsh-link `POST /` endpoint accepts. Phase 1 ships text-only; a future dsh-link
 * revision may accept rich content blocks, at which point this collapses into
 * a `structuredClone(request.prompt)` and the protocol change moves to the
 * peer.
 */
function promptToTask(prompt: ContentBlock[]): string {
  return prompt
    .map((block): string => {
      switch (block.type) {
        case 'text':
          return block.text
        default:
          // Non-text blocks become their JSON form so the dsh-link peer sees a
          // faithful, debuggable task rather than a silently dropped block.
          return JSON.stringify(block)
      }
    })
    .join('\n')
}

/**
 * Start and publish one HTTP child after the request's abort state is
 * captured. Transport-level failures settle through the run result; startup
 * cancellation rejects only after the HTTP request is torn down. Disposal
 * destroys any in-flight request and is idempotent.
 * @param request - the start request; its signal is the cancellation channel.
 * @param spec - the resolved peer, timeout, response cap, and error sink.
 * @param failureDiagnostic - provider-owned fixed safe-failure text builder.
 * @returns the ready run handle for the child HTTP request.
 */
export function startHttpRun(
  request: ResolvedSubagentStartRequest | SubagentStartRequest,
  spec: HttpRunSpec,
  failureDiagnostic: (stage: FailureStage) => string,
): Promise<SubagentRun> {
  if (request.signal.aborted) {
    throw new Error('subagent request was aborted before the HTTP child started')
  }

  const id = brandString<SessionId>(randomUUID())

  // Cancellation settles the result without waiting for a cooperative child:
  // there is no wire-level cancel to send, so destroying the in-flight request
  // is the entire cancellation ladder.
  const flags = { cancelled: false }
  let signalCancelSettled!: () => void
  const cancelSettled = new Promise<void>((resolve) => { signalCancelSettled = resolve })
  const requestCancel = (): void => {
    if (flags.cancelled) return
    flags.cancelled = true
    signalCancelSettled()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let activeRequest: ClientRequest | undefined
  const teardown = async (): Promise<void> => {
    activeRequest?.destroy()
  }

  let diagnostic: string | undefined
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      try {
        const u = new URL('/', spec.peer.url)
        const body = JSON.stringify({ task: promptToTask(request.prompt) })

        // Race the HTTP round-trip against the local cancellation signal.
        const response = await Promise.race([
          sendHttp({
            url: u,
            token: spec.peer.token,
            body,
            timeoutMs: spec.timeoutMs,
            maxResponseBytes: spec.maxResponseBytes,
            onRequest: (req) => { activeRequest = req },
          }),
          cancelSettled.then(() => Symbol.for('http.run.cancelled') as const),
        ])
        if (response === Symbol.for('http.run.cancelled')) {
          return { output: [], stopReason: 'aborted' }
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          diagnostic = failureDiagnostic('response')
          spec.onError?.(new Error(`peer ${u.host} responded ${response.statusCode}`), 'error')
          return {
            output: [],
            stopReason: 'error',
            diagnostic,
          }
        }
        let parsed: { ok?: boolean; output?: string; error?: string; exitCode?: number }
        try {
          parsed = JSON.parse(response.body) as typeof parsed
        } catch (cause) {
          diagnostic = failureDiagnostic('response')
          spec.onError?.(cause instanceof Error ? cause : new Error(String(cause)), 'error')
          return { output: [], stopReason: 'error', diagnostic }
        }
        if (parsed.ok === false) {
          diagnostic = failureDiagnostic('response')
          spec.onError?.(new Error(parsed.error ?? 'peer reported failure'), 'error')
          return {
            output: parsed.output !== undefined ? [textBlock(parsed.output)] : [],
            stopReason: 'error',
            diagnostic,
          }
        }
        return {
          output: [textBlock(parsed.output ?? response.body)],
          stopReason: 'completed',
        }
      } catch (error) {
        if (flags.cancelled) {
          return { output: [], stopReason: 'aborted' }
        }
        diagnostic = failureDiagnostic('request')
        spec.onError?.(error instanceof Error ? error : new Error(String(error)), 'error')
        return {
          output: [],
          stopReason: 'error',
          diagnostic,
        }
      }
    },
    cancelled: () => flags.cancelled,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id,
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown,
  })
}

/** Single HTTP POST result, distinct from a cancellation sentinel. */
interface HttpResponse {
  readonly statusCode: number
  readonly body: string
}

/**
 * Issue one HTTP POST with a Bearer token, a hard response-size cap, and a
 * timeout. The `onRequest` hook lets the caller destroy the in-flight socket
 * on dispose. The `teardown` argument is unused at the call site but kept on
 * the type so future retries can plug in without churning callers.
 */
function sendHttp(opts: {
  url: URL
  token: string
  body: string
  timeoutMs: number
  maxResponseBytes: number
  onRequest: (req: ClientRequest) => void
}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(opts.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(opts.body),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
    }, (res) => {
      let buf = ''
      let bytesRead = 0
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        bytesRead += Buffer.byteLength(chunk, 'utf8')
        if (bytesRead > opts.maxResponseBytes) {
          // Bound enforcement at the read site: an oversize response aborts
          // the socket before the buffer can grow past the cap.
          req.destroy(new Error(`response body exceeded ${opts.maxResponseBytes} bytes`))
          return
        }
        buf += chunk
      })
      res.on('end', () => {
        resolve({ statusCode: res.statusCode ?? 0, body: buf })
      })
      res.on('error', reject)
    })
    opts.onRequest(req)
    req.on('error', reject)
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`peer ${opts.url.host} timed out after ${opts.timeoutMs}ms`)))
    req.end(opts.body)
  })
}
