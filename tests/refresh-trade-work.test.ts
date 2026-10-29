import { readFileSync } from 'node:fs'
import { revaluationControlCases } from './db/trade-revaluation-controls.mjs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), analyze: vi.fn(), renew: vi.fn() }))
vi.mock('../supabase/functions/_shared/supabase.ts', () => ({ supabase: { rpc: mocks.rpc } }))
vi.mock('../supabase/functions/_shared/workContext.ts', () => ({ renewCurrentWorkLease: mocks.renew }))
vi.mock('../supabase/functions/_shared/tradeEstimate.ts', () => ({ analyzeTradeEstimate: mocks.analyze }))
vi.mock('../supabase/functions/_shared/dynastyEngine.ts', () => ({ DYNASTY_TRADE_MODEL_VERSION: 'model' }))
vi.mock('../supabase/functions/_shared/apiRuntime.ts', () => ({ throwDb: (error: Error) => { throw error } }))

const estimatesPath = '../supabase/functions/api/tradeEstimates.ts'
const refreshPath = '../supabase/functions/refresh-views/work.ts'
const tradesPath = '../supabase/functions/refresh-views/trades.ts'
const { revalueTrade } = await import(estimatesPath)
const { refreshViews } = await import(refreshPath)
const { refreshTradeWork } = await import(tradesPath)

const inputs = { leagueId: 'league', seasonId: 'season', seasonYear: 2027, terms: [], inputVersion: 'fingerprint', observedAt: '2026-10-29T00:00:00Z' }
beforeEach(() => { vi.clearAllMocks(); mocks.analyze.mockReturnValue({ teams: [] }); mocks.rpc.mockReset() })

describe('independent trade valuation work', () => {
  it('completes screens without requesting any valuation', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ leagueId: 'league', seasonId: 'season', version: 12, claimToken: 'claim' }] }).mockResolvedValueOnce({ data: true })
    expect((await refreshViews()).rowsAffected).toBe(1)
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual(['view_refresh_work', 'view_refresh_work'])
    expect(mocks.analyze).not.toHaveBeenCalled()
  })

  it('preserves the last publication for closed trades', async () => {
    const cached = { modelVersion: 'old', analysis: { teams: [] } }
    mocks.rpc.mockResolvedValue({ data: { closed: true, cachedRevaluation: cached } })
    expect(await revalueTrade('user', 'member', 'trade')).toEqual(cached)
    expect(mocks.analyze).not.toHaveBeenCalled()
    expect(mocks.rpc).toHaveBeenCalledOnce()
  })

  it('skips unchanged inputs without changing the publication', async () => {
    const cached = { modelVersion: 'model', analysis: { teams: [] } }
    mocks.rpc.mockResolvedValue({ data: { ...inputs, cachedRevaluation: cached } })
    expect(await revalueTrade('user', 'member', 'trade', 'fingerprint')).toBeNull()
    expect(mocks.analyze).not.toHaveBeenCalled()
    expect(mocks.rpc).toHaveBeenCalledOnce()
  })

  it('discards work for a superseded fingerprint', async () => {
    mocks.rpc.mockResolvedValue({ data: inputs })
    expect(await revalueTrade('user', 'member', 'trade', 'old')).toBeNull()
    expect(mocks.analyze).not.toHaveBeenCalled()
  })

  it('publishes changed inputs with their fingerprint', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: inputs }).mockResolvedValueOnce({ data: true })
    expect(await revalueTrade('user', 'member', 'trade', 'fingerprint')).toMatchObject({ inputVersion: 'fingerprint' })
    expect(mocks.rpc).toHaveBeenLastCalledWith('view_refresh_work', expect.objectContaining({ p_params: expect.objectContaining({ operation: 'publish-trade', revaluation: expect.objectContaining({ inputVersion: 'fingerprint' }) }) }))
    expect(mocks.analyze).toHaveBeenCalledOnce()
  })

  it('leaves a timed-out trade retryable without attempting screen work', async () => {
    mocks.rpc.mockResolvedValue({ error: new Error('canceling statement due to statement timeout') })
    await expect(refreshTradeWork({ tradeId: 'trade', memberId: 'member', userId: 'user', inputFingerprint: 'fingerprint' })).rejects.toThrow('statement timeout')
    expect(mocks.rpc).toHaveBeenCalledOnce()
    expect(mocks.rpc.mock.calls[0][0]).toBe('get_trade_revaluation_inputs')
  })

  it('queues bounded discovery separately from screen completion', async () => {
    mocks.rpc.mockResolvedValue({ data: { queued: 2 } })
    expect((await refreshTradeWork({ revaluationScan: true, seasonId: 'season', version: 12 })).rowsAffected).toBe(2)
    expect(mocks.rpc).toHaveBeenCalledWith('view_refresh_work', { p_params: expect.objectContaining({ operation: 'queue-trades', modelVersion: 'model' }) })
  })
  it('checks versions and queues changes without reading full inputs', async () => {
    mocks.rpc.mockResolvedValue({ data: true })
    expect((await refreshTradeWork({ checkInputs: true, tradeId: 'trade', memberId: 'member', userId: 'user' })).rowsAffected).toBe(1)
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('view_refresh_work', {
      p_params: { operation: 'check-trade', tradeId: 'trade', modelVersion: 'model' },
    })
    expect(mocks.analyze).not.toHaveBeenCalled()
  })

  it('skips unchanged versions in one call', async () => {
    mocks.rpc.mockResolvedValue({ data: false })
    expect((await refreshTradeWork({ checkInputs: true, tradeId: 'trade', memberId: 'member', userId: 'user' })).rowsAffected).toBe(0)
    expect(mocks.rpc).toHaveBeenCalledOnce()
    expect(mocks.analyze).not.toHaveBeenCalled()
  })

  it('waits for the live-game window before reading inputs', async () => {
    mocks.rpc.mockResolvedValue({ data: false })
    expect((await refreshTradeWork({ latestInputs: true, tradeId: 'trade', memberId: 'member', userId: 'user' })).rowsAffected).toBe(0)
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('view_refresh_work', {
      p_params: { operation: 'begin-trade', tradeId: 'trade', modelVersion: 'model' },
    })
    expect(mocks.analyze).not.toHaveBeenCalled()
  })

  it('reads current inputs when coalesced work starts', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: true }).mockResolvedValueOnce({ data: inputs }).mockResolvedValueOnce({ data: true })
    expect((await refreshTradeWork({ latestInputs: true, tradeId: 'trade', memberId: 'member', userId: 'user', inputFingerprint: 'obsolete' })).rowsAffected).toBe(1)
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual(['view_refresh_work', 'get_trade_revaluation_inputs', 'view_refresh_work'])
    expect(mocks.analyze).toHaveBeenCalledOnce()
    expect(mocks.rpc.mock.calls[2][1].p_params.revaluation.inputVersion).toBe('fingerprint')
  })
  it('reuses checked inputs while checking the trade is still open before analysis', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: true }).mockResolvedValueOnce({ data: true })
    expect(await revalueTrade('user', 'member', 'trade', 'fingerprint', inputs)).toMatchObject({ inputVersion: 'fingerprint' })
    expect(mocks.rpc.mock.calls.map(call => call[0])).toEqual(['view_refresh_work', 'view_refresh_work'])
    expect(mocks.rpc.mock.calls[0][1].p_params.operation).toBe('trade-ready')
  })

  it('checks the bounded average-refresh guard against a full-refresh control', () => {
    const source = readFileSync('supabase/sql/functions/by-name/private/refresh_player_averages.sql', 'utf8')
    const bounded = (sql: string) => sql.includes('IF NOT full_refresh AND affected IS NULL THEN RETURN true')
      && sql.includes('full_refresh OR average.player_id=ANY(affected)')
      && sql.includes('full_refresh OR player_id=ANY(affected)')
    expect(bounded(source)).toBe(true)
    expect(bounded(source.replaceAll('full_refresh OR player_id=ANY(affected)', 'true'))).toBe(false)
    expect(bounded(source.replace('IF NOT full_refresh AND affected IS NULL THEN RETURN true', 'IF false THEN RETURN true'))).toBe(false)
  })

  it.each(revaluationControlCases())('$name has a distinct broken control and an executed SQL assertion', ({ original, definition, recipe, expected }) => {
    expect(definition).not.toBe(original)
    expect(readFileSync(`tests/db/${recipe}.sql`, 'utf8')).toContain(expected)
  })

})
