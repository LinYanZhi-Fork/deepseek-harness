#!/usr/bin/env node
/**
 * Test driver: one delegation turn through a headless Loader composition that
 * mounts the dsh-link subagent provider against an in-process HTTP server
 * impersonating a dsh-link peer. The driver owns the mock peer so the provider
 * exercises the real HTTP transport on the loopback without depending on an
 * external process or an actual dsh-link installation.
 */

import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { bootProductionProfile } from '../../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'
import { startMockPeerServer } from './mock-peer-server.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('subagent-dsh-link driver requires a config path')

const peer = await startMockPeerServer()
process.env.DSH_TEST_DSH_LINK_PEER_URL = peer.url

const ctx = await bootProductionProfile({
  binName: 'subagent-dsh-link-e2e',
  profile: 'headless',
  overlayPaths: [resolveConfigPath(configPath, undefined)],
})
try {
  await runFixtureTurn(ctx, { task: 'delegate' })
} finally {
  await ctx.fiber.dispose()
  await peer.close()
}
