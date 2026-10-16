import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWebTargets } from './e2e/web-targets.mjs'

type Week = { season_year: number; week_number: number; week_start: string; week_end: string }

const boundary = vi.hoisted(() => ({ weeks: [] as Week[], observed: [] as Week[] }))

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
    from: (table: string) => {
        let deleting = false
        let numbers: number[] = []
        const query = {
            select: () => query,
            eq: () => query,
            order: () => query,
            like: () => query,
            limit: () => query,
            in: (_column: string, values: number[]) => { numbers = values; return query },
            delete: () => { deleting = true; return query },
            upsert: async (rows: Week[]) => {
                for (const row of rows) {
                    boundary.weeks = boundary.weeks.filter((old) => old.week_number !== row.week_number)
                    boundary.weeks.push({ ...row })
                }
                return { error: null }
            },
            single: async () => ({ data: { id: 'season', season_year: 2027, name: 'Seed league' }, error: null }),
            then: (resolve: (value: { data: unknown; error: null }) => unknown) => {
                if (deleting) boundary.weeks = boundary.weeks.filter((row) => !numbers.includes(row.week_number))
                const data = table === 'league_members'
                    ? [{ id: 'me', user_id: 'user', team_name: 'My team' }, { id: 'other', user_id: 'peer', team_name: 'Peer' }]
                    : table === 'players' ? [{ id: 'player' }] : boundary.weeks.map((row) => ({ ...row }))
                return resolve({ data, error: null })
            },
        }
        return query
    },
}) }))

vi.mock('node:fs/promises', () => ({
    mkdir: vi.fn(), writeFile: vi.fn(),
    readFile: async (file: string | URL) => String(file).endsWith('e2e-state.json')
        ? JSON.stringify({ leagueId: 'league', password: 'synthetic-password', users: [{ id: 'user' }, { id: 'peer' }] })
        : '',
}))
vi.mock('node:child_process', () => ({ execFileSync: (_command: string, args: string[]) => args[0] === 'rev-parse' ? 'fixture-head' : '' }))
vi.mock('./e2e/browser-smoke.mjs', () => ({ ensureSweepDrafts: async () => ({ auctionDraft: { id: 'auction' }, rookieDraft: { id: 'rookie' } }) }))
vi.mock('./e2e/web-targets-browser.mjs', () => ({
    WEB_TARGETS: [{ id: 'desktop-chromium-1280' }],
    openWebTarget: async () => {
        boundary.observed = boundary.weeks.map((row) => ({ ...row }))
        throw new Error('Stop at first browser')
    },
    readWebLayout: vi.fn(), pressWebControl: vi.fn(), pinWebTargetLeague: vi.fn(),
}))
vi.mock('./e2e/web-targets-update.mjs', () => ({ runWebTargetUpdates: vi.fn() }))
vi.mock('./e2e/web-targets-slots.mjs', () => ({ checkWebEmptySlots: vi.fn() }))
vi.mock('./e2e/web-targets-actions.mjs', () => ({ runWebActionTargets: vi.fn() }))
vi.mock('./e2e/web-targets-gameplay.mjs', () => ({ runWebGameplayTargets: vi.fn() }))
vi.mock('./e2e/soak-fixtures.mjs', async (importOriginal) => ({
    ...await importOriginal<typeof import('./e2e/soak-fixtures.mjs')>(),
    createDisposableLeagueFromSeedUsers: async () => ({ league: { id: 'competing', name: 'Competing league' }, members: [{ id: 'competing-me' }] }),
}))

beforeEach(() => {
    boundary.weeks = []
    boundary.observed = []
    vi.stubEnv('E2E_SUPABASE_URL', 'http://127.0.0.1:54321')
    vi.stubEnv('E2E_WEB_TARGET_FILTER', '')
    vi.stubEnv('E2E_WEB_TARGET_ACTIONS', '')
    vi.stubEnv('E2E_WEB_TARGET_GAMEPLAY', '')
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ commitSha: 'release', bundleDigest: 'digest' }) })))
})

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('web matrix fixture calendar', () => {
    it('creates its own calendar before opening a browser on a fresh seed', async () => {
        await expect(runWebTargets()).rejects.toThrow('Stop at first browser')
        expect(boundary.observed.map((row) => row.week_number)).toEqual(Array.from({ length: 26 }, (_, index) => index + 1))
        expect(boundary.weeks).toEqual([])
    })

    it('restores an existing calendar when browser setup fails', async () => {
        const original = { season_year: 2027, week_number: 1, week_start: '2026-10-12', week_end: '2026-10-18' }
        boundary.weeks = [{ ...original }]
        await expect(runWebTargets()).rejects.toThrow('Stop at first browser')
        expect(boundary.observed).toHaveLength(26)
        expect(boundary.weeks).toEqual([original])
    })
})
