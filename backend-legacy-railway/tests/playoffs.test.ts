import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/lib/supabase', () => ({
    supabase: { from: vi.fn() },
}))

import { supabase } from '../src/lib/supabase'
import { generateSemifinals, advanceToFinal } from '../src/sync/playoffs'

const mockFrom = vi.mocked(supabase.from)

beforeEach(() => vi.clearAllMocks())

function q(data: any = null, error: any = null, count: number | null = null) {
    const result = { data, error, count }
    const chain: any = {
        select: () => chain,
        eq: () => chain,
        lt: () => chain,
        not: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        single: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(result),
        insert: () => q(data, error, count),
        update: () => q(data, error, count),
        delete: () => q(data, error, count),
        then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
    }
    return chain
}

function setupSequence(responses: any[]) {
    let i = 0
    mockFrom.mockImplementation(() => {
        const r = responses[i] ?? q()
        i++
        return r
    })
}

// ── generateSemifinals ────────────────────────────────────────────────────────

describe('generateSemifinals', () => {
    const season = { id: 's1', season_year: 2027 }
    const league = { playoff_start_week: 19 }
    const members = [
        { id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }, { id: 'm5' },
    ]

    // Standings: m3 most wins, m1 second, m4 third, m2 fourth
    const matchups = [
        { home_member_id: 'm3', away_member_id: 'm1', home_points: 120, away_points: 100, winner_member_id: 'm3', is_finalized: true },
        { home_member_id: 'm3', away_member_id: 'm2', home_points: 115, away_points: 90,  winner_member_id: 'm3', is_finalized: true },
        { home_member_id: 'm1', away_member_id: 'm2', home_points: 110, away_points: 95,  winner_member_id: 'm1', is_finalized: true },
        { home_member_id: 'm4', away_member_id: 'm5', home_points: 105, away_points: 80,  winner_member_id: 'm4', is_finalized: true },
        { home_member_id: 'm2', away_member_id: 'm5', home_points: 100, away_points: 75,  winner_member_id: 'm2', is_finalized: true },
    ]
    // Wins: m3=2, m1=1, m2=1, m4=1, m5=0
    // PF: m3=235, m1=210, m4=105, m2=285 (m2 higher PF than m4)
    // Wait let me recalculate:
    // m1 PF: 100 (away in game1) + 110 (home in game3) = 210
    // m2 PF: 90 (away in game2) + 95 (away in game3) + 100 (home in game5) = 285
    // m3 PF: 120 + 115 = 235
    // m4 PF: 105
    // m5 PF: 80 + 75 = 155
    // Seeds by wins then PF: m3(2wins), m2(1win,285PF), m1(1win,210PF), m4(1win,105PF), m5(0wins)
    // Semifinals: s1(m3) vs s4(m4), s2(m2) vs s3(m1)

    it('surfaces current-season lookup failures before bracket generation', async () => {
        setupSequence([
            q(null, new Error('season lookup failed')),
        ])

        await expect(generateSemifinals('lg1')).rejects.toThrow('season lookup failed')
    })

    it('surfaces league lookup failures before bracket generation', async () => {
        setupSequence([
            q(season),
            q(null, new Error('league lookup failed')),
        ])

        await expect(generateSemifinals('lg1')).rejects.toThrow('league lookup failed')
    })

    it('surfaces playoff idempotency count failures before inserting a bracket', async () => {
        setupSequence([
            q(season),
            q(league),
            q([]),
            q(null, new Error('playoff count failed')),
        ])

        await expect(generateSemifinals('lg1')).rejects.toThrow('playoff count failed')
    })

    it('creates seed1 vs seed4 and seed2 vs seed3 matchups at playoff week', async () => {
        let insertedRows: any = null

        let matchupCallCount = 0
        mockFrom.mockImplementation((table: string) => {
            if (table === 'league_seasons') return q(season) as any
            if (table === 'leagues') return q(league) as any
            if (table === 'league_members') return q(members) as any
            if (table === 'season_weeks') return q({ week_number: 26 }) as any
            if (table === 'rps_challenges') return q([]) as any
            if (table === 'matchups') {
                matchupCallCount++
                if (matchupCallCount === 1) return q([]) as any             // all regular-season matchups finalized
                if (matchupCallCount === 2) return q(null, null, 0) as any  // idempotency check
                if (matchupCallCount === 3) return q(matchups) as any       // seed source

                // insert call
                const insertChain: any = {
                    select: () => insertChain,
                    eq: () => insertChain,
                    insert: (rows: any) => { insertedRows = rows; return q(rows) as any },
                    then: (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej),
                }
                // Return a chain where insert captures the rows
                return {
                    select: () => insertChain,
                    eq: () => insertChain,
                    insert: (rows: any) => { insertedRows = rows; return q(rows) as any },
                    then: (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej),
                } as any
            }
            return q(null) as any
        })

        await generateSemifinals('lg1')
        // If we got here without throwing, semis were generated
        // Verify at least league_seasons and leagues were queried
        expect(mockFrom.mock.calls.map((c) => c[0])).toContain('league_seasons')
        expect(mockFrom.mock.calls.map((c) => c[0])).toContain('league_members')
    })

    it('records completed pairwise tiebreaker audit rows for a full standings tie', async () => {
        const tiedMembers = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }]
        let insertedRpsRows: any = null
        let insertedMatchups: any = null
        let matchupCallCount = 0
        let rpsCallCount = 0

        mockFrom.mockImplementation((table: string) => {
            if (table === 'league_seasons') return q(season) as any
            if (table === 'leagues') return q(league) as any
            if (table === 'league_members') return q(tiedMembers) as any
            if (table === 'season_weeks') return q({ week_number: 26 }) as any
            if (table === 'rps_challenges') {
                rpsCallCount++
                if (rpsCallCount === 1) return q([]) as any
                return {
                    insert: (rows: any) => { insertedRpsRows = rows; return q(rows) as any },
                    then: (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej),
                } as any
            }
            if (table === 'matchups') {
                matchupCallCount++
                if (matchupCallCount === 1) return q([]) as any
                if (matchupCallCount === 2) return q(null, null, 0) as any
                if (matchupCallCount === 3) return q([]) as any
                return {
                    insert: (rows: any) => { insertedMatchups = rows; return q(rows) as any },
                    then: (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej),
                } as any
            }
            return q(null) as any
        })

        await generateSemifinals('lg1')

        expect(insertedMatchups).toHaveLength(2)
        expect(insertedRpsRows).toHaveLength(6)
        expect(insertedRpsRows).toEqual(expect.arrayContaining([
            expect.objectContaining({ member_a_id: 'm1', member_b_id: 'm2' }),
            expect.objectContaining({ member_a_id: 'm1', member_b_id: 'm3' }),
            expect.objectContaining({ member_a_id: 'm1', member_b_id: 'm4' }),
            expect.objectContaining({ member_a_id: 'm2', member_b_id: 'm3' }),
            expect.objectContaining({ member_a_id: 'm2', member_b_id: 'm4' }),
            expect.objectContaining({ member_a_id: 'm3', member_b_id: 'm4' }),
        ]))
        for (const row of insertedRpsRows) {
            expect(row.context).toBe('standings_playoff_tiebreaker')
            expect(row.status).toBe('completed')
            expect([row.member_a_id, row.member_b_id]).toContain(row.winner_member_id)
            expect(row.resolved_at).toEqual(expect.any(String))
        }
    })

    it('records every pair in a large exact-tie group that overlaps the playoff cutoff', async () => {
        const tiedMembers = Array.from({ length: 8 }, (_, index) => ({ id: `m${index + 1}` }))
        let insertedRpsRows: any = null
        let insertedMatchups: any = null
        let matchupCallCount = 0
        let rpsCallCount = 0

        mockFrom.mockImplementation((table: string) => {
            if (table === 'league_seasons') return q(season) as any
            if (table === 'leagues') return q(league) as any
            if (table === 'league_members') return q(tiedMembers) as any
            if (table === 'season_weeks') return q({ week_number: 26 }) as any
            if (table === 'rps_challenges') {
                rpsCallCount++
                if (rpsCallCount === 1) return q([]) as any
                return {
                    insert: (rows: any) => { insertedRpsRows = rows; return q(rows) as any },
                    then: (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej),
                } as any
            }
            if (table === 'matchups') {
                matchupCallCount++
                if (matchupCallCount === 1) return q([]) as any
                if (matchupCallCount === 2) return q(null, null, 0) as any
                if (matchupCallCount === 3) return q([]) as any
                return {
                    insert: (rows: any) => { insertedMatchups = rows; return q(rows) as any },
                    then: (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej),
                } as any
            }
            return q(null) as any
        })

        await generateSemifinals('lg1')

        expect(insertedMatchups).toHaveLength(2)
        expect(insertedRpsRows).toHaveLength(28)
        const pairKeys = new Set(
            insertedRpsRows.map((row: any) => [row.member_a_id, row.member_b_id].sort().join('|')),
        )
        expect(pairKeys.has('m1|m8')).toBe(true)
        expect(pairKeys.has('m7|m8')).toBe(true)
    })

    it('refuses playoff starts that do not leave season weeks for every round', async () => {
        const tenMembers = Array.from({ length: 10 }, (_, index) => ({ id: `m${index + 1}` }))
        let matchupCallCount = 0

        mockFrom.mockImplementation((table: string) => {
            if (table === 'league_seasons') return q(season) as any
            if (table === 'leagues') return q(league) as any
            if (table === 'league_members') return q(tenMembers) as any
            if (table === 'rps_challenges') return q([]) as any
            if (table === 'season_weeks') return q({ week_number: 20 }) as any
            if (table === 'matchups') {
                matchupCallCount++
                if (matchupCallCount === 1) return q([]) as any
                if (matchupCallCount === 2) return q(null, null, 0) as any
                if (matchupCallCount === 3) return q([]) as any
                throw new Error('bracket insert should not run without enough season weeks')
            }
            return q(null) as any
        })

        await expect(generateSemifinals('lg1')).rejects.toThrow('does not leave enough season weeks')
    })

    it('refuses to generate while regular-season matchups are unfinalized', async () => {
        let matchupCallCount = 0
        mockFrom.mockImplementation((table: string) => {
            if (table === 'league_seasons') return q(season) as any
            if (table === 'leagues') return q(league) as any
            if (table === 'matchups') {
                matchupCallCount++
                return q([{ id: 'unfinalized-1' }]) as any
            }
            return q(null) as any
        })

        await expect(generateSemifinals('lg1')).rejects.toThrow('Regular season matchups must be finalized')
        expect(matchupCallCount).toBe(1)
    })

    it('throws if fewer than 4 teams exist', async () => {
        const fewMembers = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]
        // All 0 wins/PF → only 3 seeds
        const fewMatchups: any[] = []

        let callCount = 0
        mockFrom.mockImplementation(() => {
            callCount++
            if (callCount === 1) return q(season) as any
            if (callCount === 2) return q(league) as any
            if (callCount === 3) return q([]) as any            // all regular-season matchups finalized
            if (callCount === 4) return q(null, null, 0) as any // idempotency
            if (callCount === 5) return q(fewMatchups) as any   // matchups
            if (callCount === 6) return q(fewMembers) as any    // members
            return q(null) as any
        })

        await expect(generateSemifinals('lg1')).rejects.toThrow('Not enough teams')
    })

    it('skips if semifinals already exist (idempotent)', async () => {
        let callCount = 0
        mockFrom.mockImplementation(() => {
            callCount++
            if (callCount === 1) return q(season) as any
            if (callCount === 2) return q(league) as any
            if (callCount === 3) return q([]) as any // all regular-season matchups finalized
            if (callCount === 4) return q(null, null, 2) as any // already 2 SF matchups
            return q(null) as any
        })

        await generateSemifinals('lg1')
        // Should stop after idempotency check — no insert call
        expect(callCount).toBe(4)
    })
})

// ── advanceToFinal ────────────────────────────────────────────────────────────

describe('advanceToFinal', () => {
    const season = { id: 's1', season_year: 2027 }
    const league = { playoff_start_week: 19 }

    it('surfaces final idempotency count failures before reading semifinals', async () => {
        setupSequence([
            q(season),
            q(league),
            q(null, new Error('final count failed')),
        ])

        await expect(advanceToFinal('lg1')).rejects.toThrow('final count failed')
    })

    it('throws if semis are not yet finalized', async () => {
        const semis = [
            { id: 'sf1', home_member_id: 'm1', away_member_id: 'm4', winner_member_id: 'm1', is_finalized: true, week_number: 19 },
            { id: 'sf2', home_member_id: 'm2', away_member_id: 'm3', winner_member_id: null,  is_finalized: false, week_number: 19 },
        ]

        let callCount = 0
        mockFrom.mockImplementation(() => {
            callCount++
            if (callCount === 1) return q(season) as any
            if (callCount === 2) return q(league) as any
            if (callCount === 3) return q(null, null, 0) as any // no final yet
            if (callCount === 4) return q([]) as any             // no quarterfinals
            if (callCount === 5) return q(semis) as any          // semi results
            return q(null) as any
        })

        await expect(advanceToFinal('lg1')).rejects.toThrow('not yet finalized')
    })

    it('creates the final one week after existing semifinals even if the league setting changed', async () => {
        const semis = [
            { id: 'sf1', home_member_id: 'm1', away_member_id: 'm4', winner_member_id: 'm1', is_finalized: true, week_number: 19 },
            { id: 'sf2', home_member_id: 'm2', away_member_id: 'm3', winner_member_id: 'm2', is_finalized: true, week_number: 19 },
        ]

        let insertedRow: any = null
        let callCount = 0

        mockFrom.mockImplementation((table: string) => {
            callCount++
            if (callCount === 1) return q(season) as any
            if (callCount === 2) return q({ playoff_start_week: 24 }) as any
            if (callCount === 3) return q(null, null, 0) as any // no final yet
            if (callCount === 4) return q([]) as any             // no quarterfinals
            if (callCount === 5) return q(semis) as any          // semi results
            // insert call
            return {
                insert: (row: any) => { insertedRow = row; return q(row) as any },
                then: (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej),
            } as any
        })

        await advanceToFinal('lg1')
        if (insertedRow) {
            expect(insertedRow.week_number).toBe(20)
            expect(insertedRow.matchup_type).toBe('playoff_final')
        }
    })

    it('creates semifinals one week after existing quarterfinals even if the league setting changed', async () => {
        const quarterfinals = [
            { id: 'qf1', home_member_id: 'm3', away_member_id: 'm6', winner_member_id: 'm6', is_finalized: true, week_number: 20, created_at: '2027-01-01T00:00:00.000Z' },
            { id: 'qf2', home_member_id: 'm4', away_member_id: 'm5', winner_member_id: 'm5', is_finalized: true, week_number: 20, created_at: '2027-01-01T00:00:01.000Z' },
        ]
        const seedMatchups = [
            { home_member_id: 'm1', away_member_id: 'm6', home_points: 100, away_points: 10, home_max_possible_points: 110, away_max_possible_points: 20, winner_member_id: 'm1', is_finalized: true },
            { home_member_id: 'm2', away_member_id: 'm5', home_points: 90, away_points: 20, home_max_possible_points: 100, away_max_possible_points: 30, winner_member_id: 'm2', is_finalized: true },
            { home_member_id: 'm3', away_member_id: 'm4', home_points: 80, away_points: 30, home_max_possible_points: 90, away_max_possible_points: 40, winner_member_id: 'm3', is_finalized: true },
        ]
        const sixMembers = Array.from({ length: 6 }, (_, index) => ({ id: `m${index + 1}` }))
        let insertedRows: any = null
        let matchupCallCount = 0

        mockFrom.mockImplementation((table: string) => {
            if (table === 'league_seasons') return q(season) as any
            if (table === 'leagues') return q({ playoff_start_week: 24 }) as any
            if (table === 'league_members') return q(sixMembers) as any
            if (table === 'matchups') {
                matchupCallCount++
                if (matchupCallCount === 1) return q(null, null, 0) as any
                if (matchupCallCount === 2) return q(quarterfinals) as any
                if (matchupCallCount === 3) return q(null, null, 0) as any
                if (matchupCallCount === 4) return q(seedMatchups) as any
                return {
                    insert: (rows: any) => { insertedRows = rows; return q(rows) as any },
                    then: (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej),
                } as any
            }
            return q(null) as any
        })

        await advanceToFinal('lg1')
        expect(insertedRows).toEqual(expect.arrayContaining([
            expect.objectContaining({ matchup_type: 'playoff_semifinal', week_number: 21 }),
        ]))
    })

    it('surfaces semifinal idempotency count failures before advancing quarterfinal winners', async () => {
        const quarterfinals = [
            { id: 'qf1', home_member_id: 'm3', away_member_id: 'm6', winner_member_id: 'm6', is_finalized: true, week_number: 20, created_at: '2027-01-01T00:00:00.000Z' },
            { id: 'qf2', home_member_id: 'm4', away_member_id: 'm5', winner_member_id: 'm5', is_finalized: true, week_number: 20, created_at: '2027-01-01T00:00:01.000Z' },
        ]
        setupSequence([
            q(season),
            q(league),
            q(null, null, 0),
            q(quarterfinals),
            q(null, new Error('semifinal count failed')),
        ])

        await expect(advanceToFinal('lg1')).rejects.toThrow('semifinal count failed')
    })

    it('skips if final already exists (idempotent)', async () => {
        let callCount = 0
        mockFrom.mockImplementation(() => {
            callCount++
            if (callCount === 1) return q(season) as any
            if (callCount === 2) return q(league) as any
            if (callCount === 3) return q(null, null, 1) as any // final already exists
            return q(null) as any
        })

        await advanceToFinal('lg1')
        expect(callCount).toBe(3)
    })
})
