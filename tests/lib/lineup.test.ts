import { beforeEach, expect, it, vi } from 'vitest'
import { autoSetLineup } from '@/lib/lineup/autoSet'
import { apiPost } from '@/lib/shared/api'

const mocks = vi.hoisted(() => ({ getWeekDays: vi.fn(), from: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }))
vi.mock('@/lib/lineup/read', () => ({ getWeekDays: mocks.getWeekDays, gameHasStarted: vi.fn() }))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2026-04-22' }))
vi.mock('@/lib/shared/api', () => ({ apiPost: vi.fn() }))

const result = { dates: 1, optimized: 1, skipped: 0, failed: 0, results: [{ date: '2026-04-22', status: 'optimized' }] }
const request = (date: string | null, season?: boolean, retryDates?: string[]) =>
    autoSetLineup('member', 'league', 'season', 20, 2026, date, season, retryDates)
const endpoint = '/league/lineup/auto-set-season'
const owner = { memberId: 'member', leagueId: 'league', leagueSeasonId: 'season' }

beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(apiPost).mockResolvedValue(result)
    mocks.getWeekDays.mockResolvedValue(['20', '21', '22', '23', '24', '25', '26'].map(day => ({ date: `2026-04-${day}` })))
})

it('sends Today to the server and returns its result without client roster reads or writes', async () => {
    expect(await request('2026-04-22')).toEqual(result)
    expect(apiPost).toHaveBeenCalledExactlyOnceWith(endpoint, { ...owner, dates: ['2026-04-22'] })
    expect(mocks.from).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
})

it('sends the remaining week dates in one server request', async () => {
    await request(null)
    expect(mocks.getWeekDays).toHaveBeenCalledExactlyOnceWith(20, 2026)
    expect(apiPost).toHaveBeenCalledExactlyOnceWith(endpoint, { ...owner, dates: ['2026-04-22', '2026-04-23', '2026-04-24', '2026-04-25', '2026-04-26'] })
})

it.each(['2026-04-21', null])('returns an empty result when the requested date range is past: %s', async (date) => {
    mocks.getWeekDays.mockResolvedValue([{ date: '2026-04-21' }])
    expect(await request(date)).toEqual({ dates: 0, optimized: 0, skipped: 0, failed: 0, results: [] })
    expect(apiPost).not.toHaveBeenCalled()
})

it('sends the rest of the season without a date filter', async () => {
    await request(null, true)
    expect(apiPost).toHaveBeenCalledExactlyOnceWith(endpoint, owner)
    expect(mocks.getWeekDays).not.toHaveBeenCalled()
})

it('retries only failed dates for a week', async () => {
    await request(null, false, ['2026-04-24'])
    expect(apiPost).toHaveBeenCalledExactlyOnceWith(endpoint, { ...owner, dates: ['2026-04-24'] })
})

it('preserves partial failure details from the server', async () => {
    const partial = { ...result, optimized: 0, failed: 1, results: [{ date: '2026-04-22', status: 'failed' }] }
    vi.mocked(apiPost).mockResolvedValueOnce(partial)
    expect(await request('2026-04-22')).toEqual(partial)
})

it('reports a server failure to the caller', async () => {
    vi.mocked(apiPost).mockRejectedValueOnce(new Error('Server offline'))
    await expect(request('2026-04-22')).rejects.toThrow('Server offline')
})
