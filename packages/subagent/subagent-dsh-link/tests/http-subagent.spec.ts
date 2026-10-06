/**
 * Behavior tests for `startHttpRun` against an in-process `http.createServer`
 * impersonating a dsh-link peer. Each test owns one ephemeral port and
 * disposes the server and any in-flight request on teardown. The seam's
 * settleRunResult + subprocessRunHandle contract is treated as black-box;
 * the tests assert the run's surface, not the seam's internals.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ResolvedSubagentStartRequest,
  SubagentResult,
  SubagentStartRequest,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import { resolveChildCwd } from '@deepseek-ai/dsh-subagent'
import { startHttpRun } from '../src/run.ts'
import type { HttpRunSpec } from '../src/run.ts'

/** Fixed diagnostic factory mirrored from `src/index.ts` for the test surface. */
const TEST_DIAGNOSTIC = (stage: string): string => `Subagent failure (provider: dsh-link; stage: ${stage}; category: unknown)`

/** In-process dsh-link server impersonation. */
class FakePeer {
  readonly server: Server
  url: string = ''

  constructor(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    this.server = createServer(handler)
  }

  async listen(): Promise<void> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    const address = this.server.address() as AddressInfo
    this.url = `http://127.0.0.1:${String(address.port)}`
  }

  async close(): Promise<void> {
    if (!this.server.listening) return
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve())
    })
  }
}

/** Build one resolved start request with the minimum shape the run needs. */
function makeRequest(overrides: Partial<ResolvedSubagentStartRequest> = {}): ResolvedSubagentStartRequest {
  const prompt: ContentBlock[] = [{ type: 'text', text: 'hello remote peer' }]
  const signal = new AbortController().signal
  const parent = {
    session: {
      id: brandString<SessionId>('session-parent-test'),
      header: { cwd: tmpdir() },
    },
    ctx: { agents: { withInitiator: async <T>(_fn: () => T | Promise<T>): Promise<T> => _fn() } },
  } as unknown as ResolvedSubagentStartRequest['parent']
  const request: ResolvedSubagentStartRequest = {
    prompt,
    parent,
    signal,
    descriptor: {
      provider: 'dsh-link',
      label: 'http-run-test',
    },
    ...overrides,
  } as ResolvedSubagentStartRequest
  // The seam requires the cwd to resolve to an absolute directory.
  resolveChildCwd('subagent-dsh-link', undefined, request.parent.session.header.cwd)
  return request
}

/** Spec factory paired with the FakePeer URL. */
function makeSpec(peer: FakePeer, overrides: Partial<HttpRunSpec> = {}): HttpRunSpec {
  return {
    peer: { name: 'fake-peer', url: peer.url, token: 'shared-secret' },
    timeoutMs: 5_000,
    maxResponseBytes: 1 * 1024 * 1024,
    ...overrides,
  }
}

describe('startHttpRun', () => {
  let peer: FakePeer
  let activeRun: { dispose: () => Promise<void> } | undefined

  beforeEach(async () => {
    // Each test stands up its own peer; the spec runner forks per test so
    // cross-test port reuse is safe.
  })

  afterEach(async () => {
    await activeRun?.dispose()
    activeRun = undefined
    await peer?.close()
  })

  it('resolves completed with the peer output on a 200 OK with { ok: true, output }', async () => {
    peer = new FakePeer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, output: 'PONG from remote' }))
    })
    await peer.listen()
    const run = await startHttpRun(makeRequest(), makeSpec(peer), TEST_DIAGNOSTIC)
    activeRun = run
    const result: SubagentResult = await run.result
    expect(result.stopReason).toBe<SubagentStopReason>('completed')
    expect(result.output).toHaveLength(1)
    expect(result.output[0]?.type).toBe('text')
    if (result.output[0]?.type === 'text') {
      expect(result.output[0].text).toBe('PONG from remote')
    }
    expect(run.localAgent).toBeUndefined()
    await run.dispose()
  })

  it('resolves error with the fixed diagnostic on { ok: false }', async () => {
    peer = new FakePeer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, output: 'partial', error: 'peer-side failure' }))
    })
    await peer.listen()
    const run = await startHttpRun(makeRequest(), makeSpec(peer), TEST_DIAGNOSTIC)
    activeRun = run
    const result = await run.result
    expect(result.stopReason).toBe<SubagentStopReason>('error')
    expect(result.diagnostic).toBe(TEST_DIAGNOSTIC('response'))
    // Raw peer error message never reaches the surface.
    expect(JSON.stringify(result)).not.toContain('peer-side failure')
    await run.dispose()
  })

  it('resolves error with the fixed diagnostic on a non-2xx HTTP status', async () => {
    peer = new FakePeer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end('boom')
    })
    await peer.listen()
    const run = await startHttpRun(makeRequest(), makeSpec(peer), TEST_DIAGNOSTIC)
    activeRun = run
    const result = await run.result
    expect(result.stopReason).toBe<SubagentStopReason>('error')
    expect(result.diagnostic).toBe(TEST_DIAGNOSTIC('response'))
    expect(JSON.stringify(result)).not.toContain('boom')
    await run.dispose()
  })

  it('resolves aborted when the parent signal fires before the peer replies', async () => {
    peer = new FakePeer((_req, _res) => {
      // Never respond; cancellation tears down the socket.
    })
    await peer.listen()
    const controller = new AbortController()
    const run = await startHttpRun(
      makeRequest({ signal: controller.signal }),
      makeSpec(peer),
      TEST_DIAGNOSTIC,
    )
    activeRun = run
    controller.abort()
    const result = await run.result
    expect(result.stopReason).toBe<SubagentStopReason>('aborted')
    await run.dispose()
  })

  it('rejects before spawning when the request was already aborted at start', () => {
    const controller = new AbortController()
    controller.abort()
    const spec: HttpRunSpec = {
      peer: { name: 'unused', url: 'http://127.0.0.1:1', token: '' },
      timeoutMs: 1000,
      maxResponseBytes: 1024,
    }
    expect(() =>
      startHttpRun(makeRequest({ signal: controller.signal }), spec, TEST_DIAGNOSTIC),
    ).toThrow(/aborted/)
  })

  it('enforces the maxResponseBytes cap by destroying the socket mid-stream', async () => {
    const big = 'x'.repeat(2048)
    peer = new FakePeer((_req, res) => {
      // Stream past the cap; the provider's read-side enforcement must abort.
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.write(big)
      res.write(big)
      res.end()
    })
    await peer.listen()
    const run = await startHttpRun(
      makeRequest(),
      makeSpec(peer, { maxResponseBytes: 1024 }),
      TEST_DIAGNOSTIC,
    )
    activeRun = run
    const result = await run.result
    expect(result.stopReason).toBe<SubagentStopReason>('error')
    expect(result.diagnostic).toBe(TEST_DIAGNOSTIC('request'))
    await run.dispose()
  })

  it('dispose is idempotent', async () => {
    peer = new FakePeer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, output: 'hi' }))
    })
    await peer.listen()
    const run = await startHttpRun(makeRequest(), makeSpec(peer), TEST_DIAGNOSTIC)
    activeRun = run
    await run.result
    await run.dispose()
    await expect(run.dispose()).resolves.toBeUndefined()
  })

  it('coalesces multi-block prompts into the dsh-link task string verbatim', async () => {
    let capturedBody = ''
    peer = new FakePeer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        capturedBody = Buffer.concat(chunks).toString('utf8')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, output: 'ok' }))
      })
    })
    await peer.listen()
    const prompt: ContentBlock[] = [
      { type: 'text', text: 'first block' },
      { type: 'text', text: 'second block' },
    ]
    const run = await startHttpRun(
      makeRequest({ prompt } as Partial<ResolvedSubagentStartRequest> as Partial<SubagentStartRequest>),
      makeSpec(peer),
      TEST_DIAGNOSTIC,
    )
    activeRun = run
    await run.result
    expect(capturedBody).toBe(JSON.stringify({ task: 'first block\nsecond block' }))
    await run.dispose()
  })
})
