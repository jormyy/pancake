import { expect, it } from 'vitest'
import { internalEdgeRequest } from '../../scripts/perf-lab/edge-routing.mjs'

it('sends internal function calls to the running private Edge server with their original body and headers', async () => {
  const request = new Request('http://127.0.0.1:57221/functions/v1/lineup-optimizer?mode=day', {
    method: 'POST', body: '{"date":"2026-10-28"}', headers: { 'x-test-context': 'fixture' },
  })
  const routed = internalEdgeRequest(request)
  expect(routed.url).toBe('http://127.0.0.1:57281/functions/v1/lineup-optimizer?mode=day')
  expect(routed.method).toBe('POST')
  expect(routed.headers.get('x-test-context')).toBe('fixture')
  expect(await routed.text()).toBe('{"date":"2026-10-28"}')
})

it('leaves database, auth and foreign endpoints unchanged for the existing network fence', () => {
  for (const url of ['http://127.0.0.1:57221/rest/v1/players', 'http://localhost:57221/auth/v1/user', 'http://127.0.0.1:58921/functions/v1/api', 'https://example.invalid/functions/v1/api']) {
    const request = new Request(url)
    expect(internalEdgeRequest(request)).toBe(request)
  }
})
