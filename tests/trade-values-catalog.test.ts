import { describe, expect, it } from 'vitest'
import { tradeValueWorkRequest } from '../scripts/season-sim/trade-value-catalog.mjs'
import { parseTradeValues } from '../supabase/functions/_shared/tradeValues'

describe('season trade-value work catalog', () => {
  it('replays the recorded source without a provider request and preserves worker authorization', async () => {
    const request = new Request('http://127.0.0.1:57821/functions/v1/sync-trade-values', {
      method: 'POST', headers: { 'x-internal-function-token': 'test-token', 'x-pancake-work-id': '12' }, body: '{}',
    })
    const replay = tradeValueWorkRequest('sync-trade-values', request)
    const body = await replay.json()
    expect(body.format).toBe('json')
    expect(parseTradeValues(body.content)).toHaveLength(468)
    expect(replay.headers.get('x-internal-function-token')).toBe('test-token')
    expect(replay.headers.get('x-pancake-work-id')).toBe('12')
  })
  it('leaves other work kinds unchanged', () => {
    const request = new Request('http://127.0.0.1:57821/functions/v1/sync-players')
    expect(tradeValueWorkRequest('sync-players', request)).toBe(request)
  })
})
