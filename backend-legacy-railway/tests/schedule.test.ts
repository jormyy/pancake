import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/supabase', () => ({ supabase: { from: vi.fn() } }))
vi.mock('../src/lib/nba', async () => {
    const actual = await vi.importActual<typeof import('../src/lib/nba')>('../src/lib/nba')
    return {
        ...actual,
        fetchSeasonSchedule: vi.fn(),
    }
})

import { supabase } from '../src/lib/supabase'
import { fetchSeasonSchedule } from '../src/lib/nba'
import { syncGameTimes } from '../src/sync/schedule'

const mockFrom = vi.mocked(supabase.from)
const mockFetchSeasonSchedule = vi.mocked(fetchSeasonSchedule)

function selectChain(data: unknown[]) {
    const chain: any = {
        select: vi.fn(() => chain),
        range: vi.fn(() => Promise.resolve({ data, error: null })),
    }
    return chain
}

function mutationChain(onUpsert: (rows: any[], options: Record<string, unknown>) => void) {
    return {
        upsert: vi.fn((rows: any[], options: Record<string, unknown>) => {
            onUpsert(rows, options)
            return Promise.resolve({ data: null, error: null })
        }),
    }
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('syncGameTimes', () => {
    it('inserts missing regular-season games and seeds season weeks for manual repair', async () => {
        mockFetchSeasonSchedule.mockResolvedValue([
            {
                gameId: '0022600001',
                gameDate: '2026-10-21',
                homeTeam: 'BOS',
                awayTeam: 'NYK',
                status: 'Scheduled',
                startedAt: '2026-10-22T00:30:00Z',
                weekNumber: 1,
                scheduleSeasonYear: '2026-27',
            },
            {
                gameId: '0022600002',
                gameDate: '2026-10-28',
                homeTeam: 'LAL',
                awayTeam: 'DEN',
                status: 'Scheduled',
                startedAt: '2026-10-29T02:00:00Z',
                weekNumber: 2,
                scheduleSeasonYear: '2026-27',
            },
            {
                gameId: '0042600001',
                gameDate: '2027-04-18',
                homeTeam: 'BOS',
                awayTeam: 'NYK',
                status: 'Scheduled',
                startedAt: '2027-04-18T19:00:00Z',
                weekNumber: 26,
                scheduleSeasonYear: '2026-27',
            },
        ])

        const upserts: { table: string; rows: any[]; options: Record<string, unknown> }[] = []
        let nbaGamesCalls = 0
        mockFrom.mockImplementation((table: string) => {
            if (table === 'nba_games' && nbaGamesCalls++ === 0) {
                return selectChain([])
            }
            return mutationChain((rows, options) => {
                upserts.push({ table, rows, options })
            }) as any
        })

        await expect(syncGameTimes()).resolves.toEqual({ updated: 0, inserted: 2, weeks: 2 })

        const gameUpsert = upserts.find((u) => u.table === 'nba_games')
        expect(gameUpsert?.options).toEqual({ onConflict: 'nba_game_id' })
        expect(gameUpsert?.rows).toMatchObject([
            {
                nba_game_id: '0022600001',
                season_year: 2027,
                game_date: '2026-10-21',
                home_team: 'BOS',
                away_team: 'NYK',
                game_time: '2026-10-22T00:30:00.000Z',
                week_number: 1,
            },
            {
                nba_game_id: '0022600002',
                season_year: 2027,
                week_number: 2,
            },
        ])

        const weekUpsert = upserts.find((u) => u.table === 'season_weeks')
        expect(weekUpsert?.options).toEqual({ onConflict: 'season_year,week_number' })
        expect(weekUpsert?.rows).toEqual([
            { season_year: 2027, week_number: 1, week_start: '2026-10-21', week_end: '2026-10-21' },
            { season_year: 2027, week_number: 2, week_start: '2026-10-28', week_end: '2026-10-28' },
        ])
    })
})
