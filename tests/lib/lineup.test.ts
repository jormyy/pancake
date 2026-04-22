import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/shared/season', () => ({
    getCurrentSeason: vi.fn(),
    getCurrentSeasonId: vi.fn(),
    getActiveSeasonId: vi.fn(),
    currentSeasonYear: vi.fn(),
}))
vi.mock('@/lib/shared/week', () => ({
    getCurrentWeekNumber: vi.fn(),
    calculateWeekNumberFromDate: vi.fn(),
}))
vi.mock('@/lib/shared/dates', () => ({ todayDateString: vi.fn() }))

import { supabase } from '@/lib/supabase'
import { todayDateString } from '@/lib/shared/dates'
import { autoSetLineup } from '@/lib/lineup'

const mockFrom = vi.mocked(supabase.from)
const mockToday = vi.mocked(todayDateString)

beforeEach(() => {
    vi.clearAllMocks()
    mockToday.mockReturnValue('2026-04-22')
})

// ── Helpers ────────────────────────────────────────────────────────────────────

function q(data: any = null, error: any = null, count: number | null = null) {
    const result = { data, error, count }
    const chain: any = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        not: () => chain,
        is: () => chain,
        gt: () => chain,
        gte: () => chain,
        lte: () => chain,
        order: () => chain,
        limit: () => chain,
        single: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(result),
        insert: () => Promise.resolve(result),
        update: () => q(data, error, count),
        delete: () => q(data, error, count),
        upsert: () => Promise.resolve(result),
        then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
    }
    return chain
}

/**
 * Smart weekly_lineups chain. Detects whether it's being used for a select or
 * a delete/insert by tracking the first method called on the chain.
 */
function makeLUChain(existingEntries: any[], insertSpy: ReturnType<typeof vi.fn>) {
    let callType: 'select' | 'write' = 'select'
    const chain: any = {
        select: () => { callType = 'select'; return chain },
        eq: () => chain,
        in: () => chain,
        is: () => chain,
        delete: () => { callType = 'write'; return chain },
        insert: (rows: any) => insertSpy(rows),
        then: (res: any, rej: any) => {
            const data = callType === 'select' ? existingEntries : null
            return Promise.resolve({ data, error: null }).then(res, rej)
        },
        single: () => Promise.resolve({ data: existingEntries?.[0] ?? null, error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
    }
    return chain
}

// ── Fixture builders ──────────────────────────────────────────────────────────

const SCORING = { points: 1, rebounds: 1.25, assists: 1.5, steals: 3, blocks: 3, turnovers: -1 }

function rp(
    playerId: string,
    position: string,
    eligPos: string[],
    team: string,
    injuryStatus: string | null = null,
) {
    return {
        id: `rp-${playerId}`,
        player_id: playerId,
        is_on_ir: false,
        is_on_taxi: false,
        players: { position, eligible_positions: eligPos, nba_team: team, injury_status: injuryStatus },
    }
}

function avg(playerId: string, avgPoints: number) {
    return {
        player_id: playerId, games_played: 60,
        avg_points: avgPoints, avg_rebounds: 0, avg_assists: 0,
        avg_steals: 0, avg_blocks: 0, avg_turnovers: 0,
        avg_three_pointers_made: 0, avg_field_goals_made: 0,
        avg_field_goals_attempted: 0, avg_free_throws_made: 0,
        avg_free_throws_attempted: 0, double_doubles: 0, triple_doubles: 0,
    }
}

function game(homeTeam: string, awayTeam: string, status = 'Scheduled') {
    const started = ['InProgress', 'Final'].includes(status)
    return {
        home_team: homeTeam,
        away_team: awayTeam,
        status,
        game_time: started
            ? new Date(Date.now() - 3_600_000).toISOString()  // 1h ago
            : new Date(Date.now() + 3_600_000).toISOString(), // 1h from now
    }
}

// ── Mock setup factory ─────────────────────────────────────────────────────────

interface MockOpts {
    roster: ReturnType<typeof rp>[]
    avgs: ReturnType<typeof avg>[]
    games: ReturnType<typeof game>[]
    templates?: Array<{ slot_type: string; slot_count: number }>
    existingEntries?: Array<{ player_id: string; slot_type: string }>
    seasonWeeks?: any   // single object for getWeekDays (weekly), array for getRemainingSeasonDates (season)
    weekGames?: ReturnType<typeof game>[] // override nba_games for the first (week-level) query
}

function setupMocks(opts: MockOpts) {
    const {
        roster, avgs, games,
        templates = [
            { slot_type: 'PG', slot_count: 1 },
            { slot_type: 'SG', slot_count: 1 },
            { slot_type: 'SF', slot_count: 1 },
        ],
        existingEntries = [],
        seasonWeeks = null,
        weekGames = null,
    } = opts

    const insertSpy = vi.fn().mockResolvedValue({ data: null, error: null })
    const tableIdx: Record<string, number> = {}

    mockFrom.mockImplementation((table: string) => {
        const idx = tableIdx[table] ?? 0
        tableIdx[table] = idx + 1

        switch (table) {
            case 'roster_players':         return q(roster)
            case 'lineup_slot_templates':  return q(templates)
            case 'mv_player_season_averages': return q(avgs)
            case 'leagues':                return q({ scoring_settings: SCORING })
            case 'season_weeks':           return q(seasonWeeks)
            case 'nba_games':
                // When weekGames provided, first call is getWeekDays week-overview query
                if (weekGames !== null && idx === 0) return q(weekGames)
                return q(games)
            case 'weekly_lineups':
                // Always pass existingEntries — makeLUChain detects select vs write internally
                return makeLUChain(existingEntries, insertSpy)
            default: return q(null)
        }
    })

    return { insertSpy, tableIdx }
}

// ── autoSetLineup — daily ─────────────────────────────────────────────────────

describe('autoSetLineup — daily', () => {
    it('places a game-day player in their matching starter slot', async () => {
        const roster = [rp('pPG', 'PG', ['PG', 'G'], 'LAL')]
        const avgs   = [avg('pPG', 30)]
        const games  = [game('LAL', 'GSW')]

        const { insertSpy } = setupMocks({ roster, avgs, games, templates: [{ slot_type: 'PG', slot_count: 1 }] })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, '2026-04-22')

        expect(insertSpy).toHaveBeenCalledOnce()
        const rows: any[] = insertSpy.mock.calls[0][0]
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ player_id: 'pPG', slot_type: 'PG' })
    })

    it('prefers a game-day player over a higher-projected player with no game', async () => {
        const roster = [
            rp('pA', 'PG', ['PG', 'G'], 'LAL'), // LAL plays today, lower projected
            rp('pB', 'PG', ['PG', 'G'], 'TOR'), // TOR has no game today, higher projected
        ]
        const avgs  = [avg('pA', 20), avg('pB', 40)]
        const games = [game('LAL', 'GSW')]       // only LAL plays

        const { insertSpy } = setupMocks({ roster, avgs, games, templates: [{ slot_type: 'PG', slot_count: 1 }] })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, '2026-04-22')

        const rows: any[] = insertSpy.mock.calls[0][0]
        expect(rows[0]).toMatchObject({ player_id: 'pA', slot_type: 'PG' })
    })

    it('does not start a player with no game when a game-day player is available for the same slot', async () => {
        const roster = [
            rp('pA', 'PG', ['PG', 'G'], 'LAL'),
            rp('pB', 'PG', ['PG', 'G'], 'TOR'), // no game
        ]
        const avgs  = [avg('pA', 20), avg('pB', 40)]
        const games = [game('LAL', 'GSW')]

        const { insertSpy } = setupMocks({ roster, avgs, games, templates: [{ slot_type: 'PG', slot_count: 1 }] })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, '2026-04-22')

        const rows: any[] = insertSpy.mock.calls[0][0]
        const hasNoGamePlayer = rows.some((r: any) => r.player_id === 'pB' && r.slot_type === 'PG')
        expect(hasNoGamePlayer).toBe(false)
    })

    it('assigns injured player (IR-eligible) projected=0 so they land on bench', async () => {
        const roster = [
            rp('pHealthy', 'PG', ['PG', 'G'], 'LAL'),
            rp('pInjured', 'PG', ['PG', 'G'], 'BOS', 'Out'),  // IR-eligible → projected=0
        ]
        const avgs = [avg('pHealthy', 20), avg('pInjured', 50)]
        const games = [game('LAL', 'GSW'), game('BOS', 'PHI')]

        const { insertSpy } = setupMocks({ roster, avgs, games, templates: [{ slot_type: 'PG', slot_count: 1 }] })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, '2026-04-22')

        const rows: any[] = insertSpy.mock.calls[0][0]
        // Healthy player should fill the PG slot; injured player stays on bench
        expect(rows.find((r: any) => r.slot_type === 'PG')?.player_id).toBe('pHealthy')
        expect(rows.find((r: any) => r.player_id === 'pInjured')).toBeUndefined()
    })

    it('processes exactly one date when gameDate is provided', async () => {
        const roster = [rp('pPG', 'PG', ['PG', 'G'], 'LAL')]
        const avgs   = [avg('pPG', 30)]
        const games  = [game('LAL', 'GSW')]

        const { insertSpy } = setupMocks({ roster, avgs, games })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, '2026-04-22')

        // One insert per day processed → exactly 1
        expect(insertSpy).toHaveBeenCalledTimes(1)
    })
})

// ── autoSetLineup — weekly ────────────────────────────────────────────────────

describe('autoSetLineup — weekly', () => {
    it('processes all future dates in the current week and skips past dates', async () => {
        // today = 2026-04-22 (Wednesday). week_start = '2026-04-22' snaps to Monday April 20.
        // Week dates: April 20–26. Filtered to >= April 22: April 22, 23, 24, 25, 26 = 5 days.
        const roster = [rp('pPG', 'PG', ['PG', 'G'], 'LAL')]
        const avgs   = [avg('pPG', 30)]
        const games  = [game('LAL', 'GSW')]

        const { insertSpy } = setupMocks({
            roster, avgs, games,
            templates: [{ slot_type: 'PG', slot_count: 1 }],
            seasonWeeks: { week_start: '2026-04-22' },
            weekGames: games, // week-level nba_games query in getWeekDays
        })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, null)

        expect(insertSpy).toHaveBeenCalledTimes(5)
    })
})

// ── autoSetLineup — season ────────────────────────────────────────────────────

describe('autoSetLineup — season', () => {
    it('processes all remaining season dates across multiple weeks', async () => {
        // 2 remaining weeks:
        // Week 20: week_start=April 22 → Monday April 20 → filter to Apr 22-26 = 5 dates
        // Week 21: week_start=April 29 → Monday April 27 → all 7 dates (Apr 27–May 3)
        // Total: 12 dates
        const roster = [rp('pPG', 'PG', ['PG', 'G'], 'LAL')]
        const avgs   = [avg('pPG', 30)]
        const games  = [game('LAL', 'GSW')]

        const { insertSpy } = setupMocks({
            roster, avgs, games,
            templates: [{ slot_type: 'PG', slot_count: 1 }],
            seasonWeeks: [
                { week_number: 20, week_start: '2026-04-22' },
                { week_number: 21, week_start: '2026-04-29' },
            ],
        })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, null, true)

        expect(insertSpy).toHaveBeenCalledTimes(12)
    })
})

// ── autoSetLineup — locked lineup preservation ────────────────────────────────

describe('autoSetLineup — locked lineup preservation', () => {
    it('does not include a locked player in the new insert batch', async () => {
        // pA (PG, LAL) — LAL game is InProgress → pA is locked in PG slot
        // pB (SG, BOS) — BOS game is Scheduled → pB is unlocked
        const roster = [
            rp('pA', 'PG', ['PG', 'G'], 'LAL'),
            rp('pB', 'SG', ['SG', 'G'], 'BOS'),
            rp('pC', 'SF', ['SF', 'F'], 'PHI'),
        ]
        const avgs = [avg('pA', 30), avg('pB', 25), avg('pC', 20)]
        const games = [
            game('LAL', 'OKC', 'InProgress'), // LAL already started → pA locked
            game('BOS', 'MIA'),
            game('PHI', 'ATL'),
        ]
        const existingEntries = [{ player_id: 'pA', slot_type: 'PG' }]

        const { insertSpy } = setupMocks({ roster, avgs, games, existingEntries })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, '2026-04-22')

        // pA is locked — must NOT appear in the new insert
        const insertedRows: any[] = insertSpy.mock.calls[0][0]
        expect(insertedRows.find((r: any) => r.player_id === 'pA')).toBeUndefined()
    })

    it('re-optimizes remaining unlocked slots when a locked player holds a slot', async () => {
        // pA locked in PG → PG slot is consumed. pB and pC fill SG and SF.
        const roster = [
            rp('pA', 'PG', ['PG', 'G'], 'LAL'),
            rp('pB', 'SG', ['SG', 'G'], 'BOS'),
            rp('pC', 'SF', ['SF', 'F'], 'PHI'),
        ]
        const avgs = [avg('pA', 30), avg('pB', 25), avg('pC', 20)]
        const games = [
            game('LAL', 'OKC', 'InProgress'),
            game('BOS', 'MIA'),
            game('PHI', 'ATL'),
        ]
        const existingEntries = [{ player_id: 'pA', slot_type: 'PG' }]

        const { insertSpy } = setupMocks({ roster, avgs, games, existingEntries })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, '2026-04-22')

        const rows: any[] = insertSpy.mock.calls[0][0]
        // Unlocked slots should be filled with available players
        expect(rows.find((r: any) => r.player_id === 'pB' && r.slot_type === 'SG')).toBeDefined()
        expect(rows.find((r: any) => r.player_id === 'pC' && r.slot_type === 'SF')).toBeDefined()
    })

    it('skips the delete call entirely when all existing entries are locked', async () => {
        // Only pA in existingEntries and pA is locked → unlockedEntryPlayerIds is empty → delete skipped
        const roster = [rp('pA', 'PG', ['PG', 'G'], 'LAL')]
        const avgs   = [avg('pA', 30)]
        const games  = [game('LAL', 'OKC', 'InProgress')]
        const existingEntries = [{ player_id: 'pA', slot_type: 'PG' }]

        const { tableIdx } = setupMocks({
            roster, avgs, games,
            templates: [{ slot_type: 'PG', slot_count: 1 }],
            existingEntries,
        })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, '2026-04-22')

        // weekly_lineups called once (only the select).
        // delete skipped (unlockedEntryPlayerIds is empty) and insert skipped (no assignments).
        expect(tableIdx['weekly_lineups']).toBe(1)
    })

    it('weekly: locked player is not moved; unlocked slots are re-optimized', async () => {
        // Same lock logic applies to every day of the week
        const roster = [
            rp('pA', 'PG', ['PG', 'G'], 'LAL'),
            rp('pB', 'SG', ['SG', 'G'], 'BOS'),
        ]
        const avgs = [avg('pA', 30), avg('pB', 25)]
        const games = [
            game('LAL', 'OKC', 'InProgress'), // locked today
            game('BOS', 'MIA'),
        ]
        const existingEntries = [{ player_id: 'pA', slot_type: 'PG' }]

        const { insertSpy } = setupMocks({
            roster, avgs, games,
            templates: [{ slot_type: 'PG', slot_count: 1 }, { slot_type: 'SG', slot_count: 1 }],
            existingEntries,
            seasonWeeks: { week_start: '2026-04-22' },
            weekGames: games,
        })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, null)

        // Each day's insert should not include pA (locked); pB should fill SG
        for (const call of insertSpy.mock.calls) {
            const rows: any[] = call[0]
            expect(rows.find((r: any) => r.player_id === 'pA')).toBeUndefined()
            expect(rows.find((r: any) => r.player_id === 'pB' && r.slot_type === 'SG')).toBeDefined()
        }
    })

    it('season: locked player is not moved; unlocked slots are re-optimized', async () => {
        const roster = [
            rp('pA', 'PG', ['PG', 'G'], 'LAL'),
            rp('pB', 'SG', ['SG', 'G'], 'BOS'),
        ]
        const avgs = [avg('pA', 30), avg('pB', 25)]
        const games = [
            game('LAL', 'OKC', 'InProgress'),
            game('BOS', 'MIA'),
        ]
        const existingEntries = [{ player_id: 'pA', slot_type: 'PG' }]

        const { insertSpy } = setupMocks({
            roster, avgs, games,
            templates: [{ slot_type: 'PG', slot_count: 1 }, { slot_type: 'SG', slot_count: 1 }],
            existingEntries,
            seasonWeeks: [{ week_number: 20, week_start: '2026-04-22' }],
        })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, null, true)

        for (const call of insertSpy.mock.calls) {
            const rows: any[] = call[0]
            expect(rows.find((r: any) => r.player_id === 'pA')).toBeUndefined()
            expect(rows.find((r: any) => r.player_id === 'pB' && r.slot_type === 'SG')).toBeDefined()
        }
    })
})

// ── autoSetLineup — position eligibility ─────────────────────────────────────

describe('autoSetLineup — position eligibility', () => {
    it('SG-eligible player cannot fill a PG-only slot', async () => {
        const roster = [rp('pSG', 'SG', ['SG', 'G'], 'BOS')]
        const avgs   = [avg('pSG', 30)]
        const games  = [game('BOS', 'LAL')]

        const { insertSpy } = setupMocks({
            roster, avgs, games,
            templates: [{ slot_type: 'PG', slot_count: 1 }],
        })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, '2026-04-22')

        // No eligible player for PG slot → no insert
        expect(insertSpy).not.toHaveBeenCalled()
    })

    it('SG-eligible player can fill a G flex slot', async () => {
        const roster = [rp('pSG', 'SG', ['SG', 'G'], 'BOS')]
        const avgs   = [avg('pSG', 30)]
        const games  = [game('BOS', 'LAL')]

        const { insertSpy } = setupMocks({
            roster, avgs, games,
            templates: [{ slot_type: 'G', slot_count: 1 }],
        })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, '2026-04-22')

        expect(insertSpy).toHaveBeenCalledOnce()
        const rows: any[] = insertSpy.mock.calls[0][0]
        expect(rows[0]).toMatchObject({ player_id: 'pSG', slot_type: 'G' })
    })

    it('pure position slots are filled before flex slots (PG before G)', async () => {
        // Two PG-eligible players, 1 PG slot and 1 G slot.
        // Best player fills PG (pure), second fills G (flex).
        const roster = [
            rp('pA', 'PG', ['PG', 'G'], 'LAL'),
            rp('pB', 'PG', ['PG', 'G'], 'BOS'),
        ]
        const avgs  = [avg('pA', 35), avg('pB', 25)]
        const games = [game('LAL', 'GSW'), game('BOS', 'PHI')]

        const { insertSpy } = setupMocks({
            roster, avgs, games,
            templates: [
                { slot_type: 'PG', slot_count: 1 },
                { slot_type: 'G', slot_count: 1 },
            ],
        })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, '2026-04-22')

        const rows: any[] = insertSpy.mock.calls[0][0]
        expect(rows.find((r: any) => r.player_id === 'pA' && r.slot_type === 'PG')).toBeDefined()
        expect(rows.find((r: any) => r.player_id === 'pB' && r.slot_type === 'G')).toBeDefined()
    })

    it('pure-C player (no PF eligibility) cannot fill PG, SG, SF, or F slots', async () => {
        // eligiblePositions: ['C'] only — F slot requires SF or PF, so no match
        const roster = [rp('pC', 'C', ['C'], 'DEN')]
        const avgs   = [avg('pC', 40)]
        const games  = [game('DEN', 'LAL')]

        const { insertSpy } = setupMocks({
            roster, avgs, games,
            templates: [
                { slot_type: 'PG', slot_count: 1 },
                { slot_type: 'SG', slot_count: 1 },
                { slot_type: 'SF', slot_count: 1 },
                { slot_type: 'F', slot_count: 1 },
            ],
        })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, '2026-04-22')

        // No slot is eligible for a pure-C player in this template → no insert
        expect(insertSpy).not.toHaveBeenCalled()
    })

    it('pure-C player fills UTIL slot', async () => {
        const roster = [rp('pC', 'C', ['C'], 'DEN')]
        const avgs   = [avg('pC', 40)]
        const games  = [game('DEN', 'LAL')]

        const { insertSpy } = setupMocks({
            roster, avgs, games,
            templates: [{ slot_type: 'UTIL', slot_count: 1 }],
        })

        await autoSetLineup('m1', 'lg1', 's1', 20, 2026, '2026-04-22')

        expect(insertSpy).toHaveBeenCalledOnce()
        const rows: any[] = insertSpy.mock.calls[0][0]
        expect(rows[0]).toMatchObject({ player_id: 'pC', slot_type: 'UTIL' })
    })
})
