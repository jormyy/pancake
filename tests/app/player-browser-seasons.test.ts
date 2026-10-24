import { expect, it, vi } from 'vitest'
import { auditWebPlayerActions } from '../e2e/web-targets-player-actions.mjs'

const setup = vi.hoisted(() => vi.fn())
vi.mock('../e2e/trade-fixture.mjs', () => ({
    setupTradeGameplayFixture: setup,
    createFixtureResourceOwner: () => ({ registerCleanup: vi.fn() }),
}))

type Row = { id?: string; season_year?: number; [key: string]: unknown }
type Query = {
    table: string
    operation: string
    rows: Row[]
    select: () => Query
    insert: (rows: Row[]) => Query
    delete: () => Query
    eq: () => Query
    in: () => Query
}

it('seeds two averaged seasons and requires Season dropdown interaction', async () => {
    const year = 2027
    const games: Row[] = []
    const stats: Row[] = []
    let refreshed = false
    const query = (table: string): Query => {
        const value: Query = {
            table, operation: 'select', rows: [],
            select: () => value,
            insert: rows => { value.operation = 'insert'; value.rows = rows; return value },
            delete: () => value,
            eq: () => value,
            in: () => value,
        }
        return value
    }
    const admin = { from: query, rpc: vi.fn(query) }
    setup.mockResolvedValue({
        admin, currentSeason: { id: 'season', season_year: year }, league: { id: 'league' },
        proposer: { id: 'member', team_name: 'Fixture Team' }, proposerPlayer: { id: 'player' },
    })
    const db = async (value: Query) => {
        if (value.table === 'refresh_player_search_caches') { refreshed = true; return [] }
        if (value.operation === 'insert' && value.table === 'nba_games') {
            const rows = value.rows.map((row, index) => ({ ...row, id: `game-${index}` }))
            games.push(...rows)
            return rows
        }
        if (value.operation === 'insert' && value.table === 'player_game_stats') stats.push(...value.rows)
        if (value.table === 'mv_player_season_averages') {
            return refreshed ? [...new Set(stats.map(row => row.season_year))].map(season_year => ({ season_year })) : []
        }
        return []
    }
    let selectedYear = String(year)
    const selected: string[] = []
    let gamePage = 0
    let gameLoads = 0
    let historyPage = 0
    let expanded = false
    const seasonSelect = {
        count: async () => refreshed && new Set(stats.map(row => row.season_year)).size === 2 ? 1 : 0,
        waitFor: async () => { expect(await seasonSelect.count()).toBe(1) },
        inputValue: async () => selectedYear,
        evaluate: async () => ({ label: 'Season', font: 16 }),
        selectOption: async (value: string) => { selected.push(value); selectedYear = value; if (value === String(year)) gamePage = 0 },
    }
    const log = { getByText: () => ({ count: async () => selectedYear === String(year) ? [15, 30, 31][gamePage] : 1 }) }
    const history = {
        getByText: (label: string) => label === 'Load More'
            ? { click: async () => { historyPage += 1 }, count: async () => historyPage < 2 ? 1 : 0 }
            : { count: async () => [20, 40, 41][historyPage] },
    }
    const button = (name: string) => name === 'League history' ? {
        getAttribute: async () => String(expanded),
        click: async () => { expanded = !expanded },
        locator: () => history,
    } : {
        click: async () => { gamePage += 1; gameLoads += 1 },
        count: async () => gamePage < 2 ? 1 : 0,
    }
    await auditWebPlayerActions({
        check: async (name: string, run: () => Promise<unknown>) => {
            if (name === 'player-game-and-history-pages') await run()
        },
        env: {}, season: 0, target: {},
        page: {
            getByRole: (role: string) => role === 'combobox' ? seasonSelect : { locator: () => log },
            locator: () => ({ evaluateAll: async () => [] }),
        },
        press: async (control: { click: () => Promise<void> }) => control.click(),
        button, open: vi.fn(), signIn: vi.fn(), db,
        wait: async (probe: () => Promise<boolean>) => { expect(await probe()).toBe(true) },
        inspect: vi.fn(),
    })
    expect([...new Set(games.map(row => row.season_year))].sort()).toEqual([year - 1, year])
    expect(stats.filter(row => row.season_year === year)).toHaveLength(31)
    expect(stats.filter(row => row.season_year === year - 1)).toHaveLength(1)
    expect(admin.rpc).toHaveBeenCalledWith('refresh_player_search_caches')
    expect(selected).toEqual([String(year - 1), String(year)])
    expect(await seasonSelect.count()).toBe(1)
    expect(gameLoads).toBe(2)
    expect(historyPage).toBe(2)
})
