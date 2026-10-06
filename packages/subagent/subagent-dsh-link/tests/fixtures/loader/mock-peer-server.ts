/**
 * In-process dsh-link peer impersonation. Owns one ephemeral port and one
 * HTTP server that responds to `POST /` with a fixed payload. The driver
 * reads the URL from `process.env.DSH_TEST_DSH_LINK_PEER_URL` after this
 * helper returns so the cordis.yml patch can bind the provider to the same
 * URL.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'

export interface MockPeer {
  readonly url: string
  close(): Promise<void>
}

export async function startMockPeerServer(): Promise<MockPeer> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
      return
    }
    const auth = req.headers.authorization
    if (auth !== 'Bearer shared-secret') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let task = ''
      try {
        task = (JSON.parse(body) as { task?: string }).task ?? ''
      } catch {
        // Fall through with empty task; the test asserts the peer responded,
        // not that the prompt was parsed.
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        output: `mock-peer-echo: ${task}`,
      }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}
