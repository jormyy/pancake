import { describe, expect, it } from 'vitest'
import {
    activePlayerFilterCount,
    availabilityPlayerScope,
    DEFAULT_PLAYER_SEARCH_PARAMS,
    playerSearchParamsKey,
    playerSeasonFilterOptions,
} from '@/lib/player-search-state'
import { sortPlayerRows } from '@/lib/player-search-sort'
import type { PlayerRow } from '@/lib/players'
import type { OwnedEntry } from '@/lib/roster'

function owned(memberId: string, teamName = 'Team'): OwnedEntry {
    return { memberId, teamName }
}

function row(id: number, points: number, rebounds: number): PlayerRow {
    return {
        id: `player-${id}`,
        display_name: `Player ${id}`,
        nba_team: id % 2 === 0 ? 'BOS' : 'NYK',
        position: 'PG',
        eligible_positions: ['PG'],
        status: null,
        injury_status: null,
        headshot_url: null,
        nba_id: null,
        years_exp: id % 50 === 0 ? 0 : 3,
        avg_points: points,
        avg_rebounds: rebounds,
    }
}

describe('player search state helpers', () => {
    it('treats the stats season as its own filter and cache identity', () => {
        expect(playerSeasonFilterOptions(2027)).toEqual([
            { key: '2027', label: '2026–27' },
            { key: '2026', label: '2025–26' },
            { key: '2025', label: '2024–25' },
        ])
        const current = playerSearchParamsKey(DEFAULT_PLAYER_SEARCH_PARAMS)
        const lastSeason = playerSearchParamsKey({ ...DEFAULT_PLAYER_SEARCH_PARAMS, seasonYear: 2026 })
        expect(lastSeason).not.toBe(current)
        const filters: Parameters<typeof activePlayerFilterCount>[0] = {
            query: '', position: 'ALL', selectedTeams: [], playingFilter: 'all', availabilityFilter: 'free_agents',
            rookiesOnly: false, health: 'all', sortMode: 'fpts', seasonYear: null,
        }
        expect(activePlayerFilterCount({ ...filters, seasonYear: null })).toBe(0)
        expect(activePlayerFilterCount({ ...filters, position: 'C', seasonYear: 2026 })).toBe(2)
    })

    it('builds deterministic cache keys for array order and duplicate churn', () => {
        const a = playerSearchParamsKey({
            ...DEFAULT_PLAYER_SEARCH_PARAMS,
            selectedTeams: ['NYK', 'BOS', 'NYK'],
            excludedTeams: ['WAS', 'ATL'],
            includePlayerIds: ['p2', 'p1', 'p1'],
        })
        const b = playerSearchParamsKey({
            ...DEFAULT_PLAYER_SEARCH_PARAMS,
            selectedTeams: ['BOS', 'NYK'],
            excludedTeams: ['ATL', 'WAS'],
            includePlayerIds: ['p1', 'p2'],
        })

        expect(a).toBe(b)
    })

    it('keeps empty include scopes explicit for waiver and mine filters', () => {
        expect(availabilityPlayerScope('waivers', new Map(), new Set())).toEqual({ includePlayerIds: [] })
        expect(availabilityPlayerScope('mine', new Map(), new Set(), 'me')).toEqual({ includePlayerIds: [] })
    })

    it('does not cache explicit empty include scopes as broad unconstrained searches', () => {
        const broad = playerSearchParamsKey(DEFAULT_PLAYER_SEARCH_PARAMS)
        const emptyScope = playerSearchParamsKey({
            ...DEFAULT_PLAYER_SEARCH_PARAMS,
            includePlayerIds: [],
        })

        expect(emptyScope).not.toBe(broad)
    })

    it('deduplicates owned and waiver exclusions for free-agent filtering', () => {
        const scope = availabilityPlayerScope(
            'free_agents',
            new Map<string, OwnedEntry>([['p2', owned('other')], ['p1', owned('me')]]),
            new Set(['p2', 'p3']),
            'me',
        )

        expect(scope.excludePlayerIds).toEqual(['p1', 'p2', 'p3'])
    })

    it('counts only active non-default filters', () => {
        expect(activePlayerFilterCount({
            query: '  ',
            position: 'ALL',
            selectedTeams: [],
            playingFilter: 'all',
            availabilityFilter: 'free_agents',
            rookiesOnly: false,
            health: 'all',
            sortMode: 'fpts',
            seasonYear: null,
        })).toBe(0)

        expect(activePlayerFilterCount({
            query: 'cade',
            position: 'G',
            selectedTeams: ['DET'],
            playingFilter: 'today',
            availabilityFilter: 'mine',
            rookiesOnly: true,
            health: 'out',
            sortMode: 'reb',
            seasonYear: null,
        })).toBe(6)
    })

    it('sorts a large in-memory complete set deterministically under load', () => {
        const players = Array.from({ length: 5_000 }, (_, index) =>
            row(index, (index * 37) % 101, (index * 19) % 53),
        )
        const sorted = sortPlayerRows(players, 'pts', 'desc')

        expect(sorted).toHaveLength(5_000)
        for (let i = 1; i < sorted.length; i++) {
            expect((sorted[i - 1].avg_points ?? 0) >= (sorted[i].avg_points ?? 0)).toBe(true)
        }
    })
})
