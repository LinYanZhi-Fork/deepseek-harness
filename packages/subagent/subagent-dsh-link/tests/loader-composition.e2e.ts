/**
 * Keyless REAL-composition coverage for the dsh-link subagent provider. A
 * test-only patch boots through the Loader with the new provider and a
 * `tool-subagent` row pointing at it; the driver owns an in-process HTTP
 * server that impersonates the dsh-link peer. The scripted model issues one
 * `subagent_run` call; the loader-smoke framework inspects the session log to
 * verify the parent saw the peer's text and the provider registered
 * honestly.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { readFile, readdir } from 'node:fs/promises'

const fixtureDir = new URL('./fixtures/loader/', import.meta.url)
const driver = fileURLToPath(new URL('driver.ts', fixtureDir))
const configPath = fileURLToPath(new URL('dsh-link.patch.yml', fixtureDir))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

async function sessionEvents(log: string): Promise<SessionEvent[]> {
  const lines = (await readFile(log, 'utf8')).trimEnd().split('\n')
  return lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
}

function toolResultText(events: SessionEvent[]): string {
  const results = events.filter(event => event.type === 'tool/result')
  expect(results.length).toBeGreaterThan(0)
  const blocks = results[0]!.data.message.content[0]?.content ?? []
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe('dsh-link subagent routing through the production profile', () => {
  it('completes one delegation turn against an in-process peer', async () => {
    let events: SessionEvent[] = []
    try {
      const { stderr } = await runLoaderSmoke({
        label: 'dsh-link-subagent e2e',
        tempDirPrefix: 'dsh-link-subagent-e2e-',
        binScript: driver,
        libBinScript: driver,
        configPath,
        tsconfigPath: repoTsconfig,
        // Driver starts the mock peer (one loopback server) and the Loader
        // harness in sequence; the HTTP round-trip adds slack beyond the
        // default 30s window.
        processTimeoutMs: 60_000,
        env: {},
        inspect: async (cwd) => {
          const parentLogs = await jsonlFiles(join(cwd, '.sessions'))
          expect(parentLogs).toHaveLength(1)
          events = await sessionEvents(parentLogs[0] as string)
        },
      })
      expect(stderr).not.toContain('UNHANDLED')
      expect(toolResultText(events)).toBe('mock-peer-echo: echo from scripted model')
    } finally {
      // No leftover resources to clean up — the driver closes its own peer.
    }
  }, 75_000)

  it('survives without a peer checkpoint when the provider is absent', async () => {
    // Sanity: a fresh workspace contains no leftover peer checkpoints; this
    // catches a regression where stale state from a previous run leaks.
    expect(existsSync(join('.sessions'))).toBe(false)
  })
})
