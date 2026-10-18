import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getLivePlayerStats } from '@/lib/games'

const state = vi.hoisted(() => ({ counts: new Map<string, number>(), fixtures: {} as Record<string, Record<string, unknown>[]> }))
vi.mock('@/lib/supabase', async () => ({ supabase: (await import('../helpers/fake-supabase')).createFakeSupabase(state.counts, state.fixtures) }))

beforeEach(() => {
    state.counts.clear()
    state.fixtures.player_game_stats = [
        { player_id: 'mine', game_date: '2026-10-18', points: 7, minutes_played: '2.5' },
        { player_id: 'theirs', game_date: '2026-10-18', points: 9, did_not_play: false },
        { player_id: 'unowned', game_date: '2026-10-18', points: 999 },
        { player_id: 'mine', game_date: '2026-10-19', points: 100 },
    ]
})

describe('selected player box scores', () => {
    it('excludes unrelated players and other dates', async () => {
        const stats = await getLivePlayerStats('2026-10-18', ['mine', 'theirs', 'mine'])
        expect([...stats.keys()]).toEqual(['mine', 'theirs'])
        expect(stats.get('mine')).toMatchObject({ points: 7, minutesPlayed: 2.5 })
        expect(stats.get('theirs')?.points).toBe(9)
        expect(state.counts.get('player_game_stats')).toBe(1)
    })

    it('makes no request for an empty selection', async () => {
        expect((await getLivePlayerStats('2026-10-18', [])).size).toBe(0)
        expect(state.counts.size).toBe(0)
    })

    it('retrieves every player across bounded request batches', async () => {
        const ids = Array.from({ length: 205 }, (_, index) => `p${index}`)
        state.fixtures.player_game_stats = ids.map(player_id => ({ player_id, game_date: '2026-10-18', points: 1 }))
        const stats = await getLivePlayerStats('2026-10-18', [...ids, ...ids])
        expect([...stats.keys()].sort()).toEqual(ids.sort())
        expect(state.counts.get('player_game_stats')).toBe(3)
    })
})
