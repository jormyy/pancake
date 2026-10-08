import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('@/lib/shared/season', () => ({ getCurrentSeason: vi.fn(), getCurrentSeasonId: vi.fn(), getActiveSeasonId: vi.fn(), currentSeasonYear: vi.fn() }))
vi.mock('@/lib/shared/week', () => ({ getCurrentWeekNumber: vi.fn(), calculateWeekNumberFromDate: vi.fn() }))
vi.mock('@/lib/games', () => ({ getLivePlayerStats: vi.fn(), getTodaysGames: vi.fn() }))

import type { LiveStatLine } from '@/lib/games'
import { lineupStatColumns, scoreBreakdown } from '@/lib/score-breakdown'
import { computeLiveFantasyPoints } from '@/lib/scoring'

const settings: Record<string, number> = {
    points: 1,
    rebounds: 1.25,
    assists: 1.5,
    steals: 3,
    blocks: 3,
    turnovers: -1,
    three_pointers_made: 0.5,
    field_goals_made: 0,
    field_goals_attempted: -0.45,
    free_throws_made: 0,
    free_throws_attempted: 0,
    double_double: 3,
    triple_double: 5,
}

function stat(overrides: Partial<LiveStatLine> = {}): LiveStatLine {
    return {
        points: 0,
        rebounds: 0,
        assists: 0,
        steals: 0,
        blocks: 0,
        turnovers: 0,
        threeMade: 0,
        fgMade: 0,
        fgAttempted: 0,
        ftMade: 0,
        ftAttempted: 0,
        fouls: 0,
        doubleDouble: false,
        tripleDouble: false,
        minutesPlayed: 34,
        didNotPlay: false,
        ...overrides,
    }
}

describe('scoreBreakdown', () => {
    it('adds up to the live fantasy points the matchup shows', () => {
        const line = stat({ points: 31, rebounds: 11, assists: 7, steals: 2, blocks: 1, turnovers: 4, threeMade: 3, fgMade: 11, fgAttempted: 23, doubleDouble: true })
        const rows = scoreBreakdown(line, settings)
        const total = rows.reduce((sum, row) => sum + (row.points ?? 0), 0)

        expect(total).toBeCloseTo(computeLiveFantasyPoints(line, settings), 2)
        expect(rows.find((row) => row.key === 'field_goals_attempted')).toMatchObject({ count: 23, points: -10.35 })
    })

    it('lists only the stats the league scores', () => {
        const keys = scoreBreakdown(stat({ points: 10 }), settings).map((row) => row.key)

        expect(keys).not.toContain('field_goals_made')
        expect(keys).not.toContain('free_throws_attempted')
        expect(keys).toContain('double_double')
    })

    it('shows no counts for a player who did not play or has no stats yet', () => {
        for (const line of [stat({ didNotPlay: true, points: 12 }), undefined]) {
            const rows = scoreBreakdown(line, settings)
            expect(rows.length).toBeGreaterThan(0)
            expect(rows.every((row) => row.count == null && row.points == null)).toBe(true)
        }
    })
})

describe('lineupStatColumns', () => {
    it('folds a scored made/attempted pair into one column', () => {
        const labels = lineupStatColumns(settings).map((column) => column.label)

        expect(labels).toEqual(['PTS', 'REB', 'AST', 'STL', 'BLK', '3PM', 'TO', 'FG'])
        expect(lineupStatColumns(settings).at(-1)?.value(stat({ fgMade: 5, fgAttempted: 9 }))).toBe('5/9')
    })

    it('falls back to the counting stats when no scoring is loaded', () => {
        expect(lineupStatColumns({}).map((column) => column.label)).toEqual(['PTS', 'REB', 'AST', 'STL', 'BLK', '3PM', 'TO'])
    })
})
