import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rosterPlayer } from '../helpers/fixtures'
import { getRosterStatusChangeLockMessage } from '@/lib/roster-locks'

const state = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], fail: false }))
vi.mock('@/lib/supabase', async () => {
    const { createFakeSupabase } = await import('../helpers/fake-supabase')
    return { supabase: { from: (table: string) => {
        if (state.fail) throw new Error('Game status unavailable')
        return createFakeSupabase(new Map(), { nba_games: state.rows }).from(table)
    } } }
})
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-12-07T05:30:00Z')); state.fail = false })
afterEach(() => vi.useRealTimers())

it.each([
    ['2026-12-06', 'InProgress', null, true],
    ['2026-12-06', 'Final', '2026-12-07T03:00:00Z', true],
    ['2026-12-06', 'Final', '2026-12-06T17:00:00Z', false],
    ['2026-12-07', 'Final', null, true],
    ['2026-12-07', 'Scheduled', '2026-12-07T23:00:00Z', false],
    ['2026-12-06', 'Scheduled', '2026-12-07T03:00:00Z', true],
])('matches the server roster lock for %s %s at %s', async (game_date, status, game_time, locked) => {
    state.rows = [{ game_date, status, game_time, started_at: null, home_team: 'LAL', away_team: 'BOS' }]
    const result = await getRosterStatusChangeLockMessage(rosterPlayer())
    expect(result !== null).toBe(locked)
})

it('fails closed when the slate cannot load', async () => {
    state.fail = true
    await expect(getRosterStatusChangeLockMessage(rosterPlayer())).rejects.toThrow('Game status unavailable')
})
