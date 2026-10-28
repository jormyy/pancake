import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedTradeValueSnapshot, robotsAllowsTradeValues, syncTradeValues, type TradeValueStore } from '../supabase/functions/_shared/tradeValues'

const fixture = readFileSync('tests/fixtures/trade-values/onenumberhoops.json', 'utf8')
const makeStore = (): TradeValueStore => ({
  claim: vi.fn().mockResolvedValue(true), cached: vi.fn().mockResolvedValue({ matched: 450 }),
  players: vi.fn().mockResolvedValue([]), overrides: vi.fn().mockResolvedValue({}),
  publish: vi.fn().mockResolvedValue({ players: 450, unmatched: 450, picks: 18 }),
})
afterEach(() => vi.restoreAllMocks())

describe('trade value sync worker', () => {
  it('checks robots before fetching and publishes one complete scaled snapshot', async () => {
    const store = makeStore()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('User-agent: *\nAllow: /'))
      .mockResolvedValueOnce(new Response(fixture))
    await syncTradeValues(store, {}, fetcher)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['https://www.onenumberhoops.com/robots.txt', 'https://www.onenumberhoops.com/api/players'])
    expect(store.publish).toHaveBeenCalledWith(expect.objectContaining({ rows: expect.arrayContaining([expect.objectContaining({ value: 999.9 })]), picks: expect.any(Array), mode: 'live' }))
    expect(fetcher.mock.calls.every(call => call[1]?.redirect === 'error')).toBe(true)
  })
  it('serves the cache without any source requests when the daily claim is unavailable', async () => {
    const store = makeStore()
    vi.mocked(store.claim).mockResolvedValue(false)
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('No network allowed'))
    expect(await syncTradeValues(store, {}, fetcher)).toEqual({ cached: true, snapshot: { matched: 450 } })
    expect(fetcher).not.toHaveBeenCalled()
    expect(store.publish).not.toHaveBeenCalled()
  })
  it('stops on blocked robots, failed HTTP, and broken source contracts', async () => {
    for (const responses of [
      [new Response('User-agent: *\nDisallow: /api/')],
      [new Response('', { status: 429 })],
      [new Response('User-agent: *\nAllow: /'), new Response('{"success":true,"data":[]}')],
    ]) {
      const store = makeStore()
      const fetcher = vi.fn<typeof fetch>()
      for (const response of responses) fetcher.mockResolvedValueOnce(response)
      await expect(syncTradeValues(store, {}, fetcher)).rejects.toThrow()
      expect(store.publish).not.toHaveBeenCalled()
    }
  })
  it('imports recorded source JSON without network or daily-fetch claims', async () => {
    const store = makeStore()
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('No network allowed'))
    await syncTradeValues(store, { format: 'json', content: fixture }, fetcher)
    expect(fetcher).not.toHaveBeenCalled()
    expect(store.claim).not.toHaveBeenCalled()
    expect(store.publish).toHaveBeenCalledOnce()
  })
  it('rejects unknown import formats and missing data', async () => {
    for (const input of [{ format: 'csv' }, { format: 'something' }]) await expect(syncTradeValues(makeStore(), input)).rejects.toThrow()
  })
  it('does not turn a failed daily attempt into a successful cache result', () => {
    expect(() => cachedTradeValueSnapshot({ fetched_at: null, last_request_at: null, matched: null })).toThrow('did not publish')
    expect(() => cachedTradeValueSnapshot({ fetched_at: '2026-10-27T08:00:00Z', last_request_at: '2026-10-28T08:00:00Z', matched: 445 })).toThrow('did not publish')
    expect(cachedTradeValueSnapshot({ fetched_at: '2026-10-28T08:01:00Z', last_request_at: '2026-10-28T08:00:00Z', matched: 445 })).toEqual({ fetchedAt: '2026-10-28T08:01:00Z', matched: 445 })
  })
})

describe('robots policy', () => {
  it('honors matching paths, specific agents, wildcards, and allow precedence', () => {
    expect(robotsAllowsTradeValues('User-agent: *\nDisallow: /api/')).toBe(false)
    expect(robotsAllowsTradeValues('User-agent: *\nDisallow: /api/*\nAllow: /api/players$')).toBe(true)
    expect(robotsAllowsTradeValues('User-agent: *\nAllow: /\nUser-agent: Pancake\nDisallow: /')).toBe(false)
    expect(robotsAllowsTradeValues('User-agent: *\nDisallow: /private/')).toBe(true)
  })
})
