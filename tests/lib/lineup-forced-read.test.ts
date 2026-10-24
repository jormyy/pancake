import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getWeeklyLineup } from '@/lib/lineup/read'
import { addFreeAgent } from '@/lib/roster'
import { clearSessionCaches } from '@/lib/session-cache-registry'

const state = vi.hoisted(() => ({
    counts: new Map<string, number>(), roster: [] as Record<string, unknown>[],
    pause: false, started: undefined as undefined | (() => void), release: undefined as undefined | (() => void),
}))
vi.mock('@/lib/shared/dates', () => ({ todayET: () => '2099-01-01', endOfETDayUTC: () => '2099-01-02T05:00:00Z' }))
vi.mock('@/lib/supabase', () => ({ supabase: {
    from: (table: string) => {
        state.counts.set(table, (state.counts.get(table) ?? 0) + 1)
        const query = {
            select: () => query, eq: () => query, order: () => query,
            then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
                const rows = table === 'lineup_slot_templates'
                    ? [{ slot_type: 'PG', slot_count: 1 }, { slot_type: 'BE', slot_count: 2 }]
                    : table === 'roster_players' ? state.roster : []
                const snapshot = { data: [...rows], error: null }
                if (table === 'roster_players' && state.pause) {
                    state.pause = false
                    const response = new Promise(done => { state.release = () => done(snapshot) })
                    state.started?.()
                    return response.then(resolve, reject)
                }
                return Promise.resolve(snapshot).then(resolve, reject)
            },
        }
        return query
    },
    rpc: async (name: string, args: { p_player_id: string }) => {
        if (name !== 'add_free_agent_atomic') throw new Error('Unexpected write')
        state.roster.push({ id: 'roster-new', player_id: args.p_player_id, is_on_ir: false, is_on_taxi: false,
            players: { display_name: 'Acquired player', position: 'PG', eligible_positions: ['PG'], nba_team: 'BOS' } })
        return { error: null }
    },
} }))

const read = (allowCachedStatics = false) => getWeeklyLineup('member', 'league', 'season', 1, '2099-01-01', { allowCachedStatics })
beforeEach(() => {
    clearSessionCaches()
    state.counts.clear()
    state.roster = []
    state.pause = false
    state.started = undefined
    state.release = undefined
})

describe('forced roster read authority', () => {
    it('reads the committed acquisition before a pre-write roster response arrives', async () => {
        state.pause = true
        const started = new Promise<void>(done => { state.started = done })
        const beforeWrite = read()
        await started
        await addFreeAgent('member', 'league', 'acquired')
        let freshSettled = false
        const afterWrite = read().then(value => { freshSettled = true; return value })
        await new Promise(done => setTimeout(done, 0))
        const finishedBeforeOldResponse = freshSettled
        state.release!()
        const [old, fresh] = await Promise.all([beforeWrite, afterWrite])
        expect(finishedBeforeOldResponse).toBe(true)
        expect(old.bench).toEqual([])
        expect(fresh.bench.map(player => player.playerId)).toEqual(['acquired'])
        expect((await read(true)).bench.map(player => player.playerId)).toEqual(['acquired'])
    })

    it('still shares an unsettled roster between explicitly cached silent reads', async () => {
        state.pause = true
        const started = new Promise<void>(done => { state.started = done })
        const first = read(true)
        await started
        const second = read(true)
        const rosterReads = state.counts.get('roster_players')
        state.release!()
        await Promise.all([first, second])
        expect(rosterReads).toBe(1)
    })

    it('keeps a single pending slot-template read for both sides of a matchup', async () => {
        await Promise.all([
            getWeeklyLineup('home', 'league', 'season', 1, '2099-01-01'),
            getWeeklyLineup('away', 'league', 'season', 1, '2099-01-01'),
        ])
        expect(state.counts.get('lineup_slot_templates')).toBe(1)
        expect(state.counts.get('roster_players')).toBe(2)
    })
})
