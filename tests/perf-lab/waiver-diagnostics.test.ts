import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { waiverDiagnostics } from '../../scripts/perf-lab/waiver-diagnostics.mjs'
import { measuredFetch } from '../../scripts/perf-lab/replay-capture.mjs'

it('records the exact waiver bid, before and after balance, response, and request ownership', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'waiver-probe-'))
  try {
    const id = '00000000-0000-4000-8000-000000000001'
    const queries: string[] = []
    const execute = async (query: string) => {
      queries.push(query)
      return JSON.stringify({ league: { startingBudget: 100 }, balances: [{ balance: 100 }], receipt: queries.length === 1 ? null : { requestId: id, actor: id } })
    }
    const file = path.join(root, 'waivers.jsonl')
    const fetcher = measuredFetch(async (request: Request) => {
      await request.text()
      return new Response(JSON.stringify({ error: 'FAAB bid exceeds your available balance.' }), { status: 400 })
    }, path.join(root, 'access.jsonl'), waiverDiagnostics(file, execute))
    const body = { leagueId: id, memberId: id, playerId: id, bidAmount: 101, requestId: id, secret: 'hidden' }
    const response = await fetcher('http://127.0.0.1:57281/functions/v1/api/waivers/claims', { method: 'POST', body: JSON.stringify(body), headers: { 'x-request-id': id, authorization: 'hidden' } })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'FAAB bid exceeds your available balance.' })
    await fetcher.flush()
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('hidden')
    expect(JSON.parse(text)).toMatchObject({ body: { bidAmount: 101, requestId: id }, requestId: id, status: 400, before: { receipt: null }, after: { receipt: { requestId: id } } })
    expect(queries).toHaveLength(2)
    expect(queries.every(query => query.includes(id))).toBe(true)
    const hooks = waiverDiagnostics(file, execute)
    expect(await hooks.before(new Request('http://127.0.0.1:57281/health'))).toBe(null)
    await expect(hooks.before(new Request('http://127.0.0.1:57281/functions/v1/api/waivers/claims', { method: 'POST', body: JSON.stringify({ ...body, leagueId: "'; DROP TABLE players;" }), headers: { 'x-request-id': id } }))).rejects.toThrow()
    expect(queries).toHaveLength(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
