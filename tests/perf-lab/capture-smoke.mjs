import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { captureServer, summarizeAccess } from '../../scripts/perf-lab/capture.mjs'
import { labRoot, json, requireMini } from '../../scripts/perf-lab/common.mjs'
import { checkSearchObserver } from './search-smoke.mjs'
import { checkBrowserCacheProxy } from './network-smoke.mjs'
import { checkSectionContent } from './content-smoke.mjs'
import { checkActionTargets } from './action-smoke.mjs'

await requireMini()
const root = path.join(labRoot, 'capture-smoke')
const evidence = path.join(root, 'evidence')
await mkdir(evidence, { recursive: true })
await writeFile(path.join(root, 'index.html'), '<main>Capture fixture</main>')
const upstream = http.createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  response.writeHead(200, { 'cache-control': 'private, max-age=12', etag: 'fixture-v1' })
  response.end(body.length ? body : 'fixture')
})
const websocket = new WebSocketServer({ server: upstream })
websocket.on('error', () => {})
websocket.on('connection', client => client.on('message', data => client.send(data)))
let capture, client
const checks = []
try {
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(57286, '127.0.0.1', () => resolve(undefined)) })
  capture = await captureServer({ root, evidence, port: 57287, apiPort: 57286 })
  capture.mark('fixture')
  const result = await fetch(`${capture.origin}/rest/v1/fixture?token=private-token`, { method: 'POST', headers: { authorization: 'Bearer private-token' }, body: 'abc' })
  assert.equal(await result.text(), 'abc')
  assert.equal(result.headers.get('etag'), 'fixture-v1')
  checks.push('proxy body and cache headers')
  const missing = await fetch(`${capture.origin}/missing.js`)
  assert.equal(missing.status, 404)
  await missing.text()
  checks.push('missing assets fail')
  client = new WebSocket(`${capture.origin.replace('http:', 'ws:')}/realtime/v1/websocket?apikey=private-token`)
  await once(client, 'open')
  const echoed = once(client, 'message')
  client.send(JSON.stringify({ topic: 'fixture', event: 'change', payload: { count: 1 } }))
  assert.equal(JSON.parse(String((await echoed)[0])).event, 'change')
  const rows = capture.rows('fixture')
  assert.equal(rows.access[0].bytesIn, 3)
  assert.equal(rows.access[0].bytesOut, 3)
  assert.equal(summarizeAccess(rows.access).requests, 2)
  assert.equal(rows.realtime.length, 2)
  assert.throws(() => assert.equal(rows.access[0].bytesOut, 0))
  checks.push('HTTP byte accounting and realtime frames, with a negative control')
  capture.mark('fault')
  capture.failRefresh('fault')
  const failed = await fetch(`${capture.origin}/rest/v1/fixture`)
  assert.equal(failed.status, 503)
  await failed.text()
  assert.equal(capture.rows('fault').access[0].injected, true)
  capture.clearFault()
  const recovered = await fetch(`${capture.origin}/rest/v1/fixture`)
  assert.equal(recovered.status, 200)
  await recovered.text()
  checks.push('Refresh fault injection and recovery')
} finally {
  client?.terminate()
  await capture?.close()
  for (const socket of websocket.clients) socket.terminate()
  await new Promise(resolve => upstream.close(resolve))
}
assert.ok(!(await readFile(path.join(evidence, 'access.jsonl'), 'utf8')).includes('private-token'))
checks.push('credential redaction')
checks.push(await checkSearchObserver())
checks.push(await checkBrowserCacheProxy())
checks.push(await checkSectionContent())
checks.push(await checkActionTargets())
await json(path.join(evidence, 'result.json'), { passed: true, checks })
console.log(JSON.stringify({ passed: checks.length, failed: 0 }))
