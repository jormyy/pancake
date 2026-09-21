import { describe, expect, it } from 'vitest'
import { PLAYER_REFERENCE_TABLES, deletePlayersWithReferences } from './e2e/harness-cleanup.mjs'
import { ensureRosterFixture } from './e2e/soak-fixtures.mjs'

type Call = { table: string; op: string; args: unknown[] }

// Minimal PostgREST-builder stand-in: records every call, resolves with the
// scripted result for `${table}.${op}`.
function fakeClient(results: Record<string, unknown> = {}) {
    const calls: Call[] = []
    const from = (table: string) => {
        const state = { op: 'select' }
        const builder: Record<string, unknown> = {}
        const chain = (op: string) => (...args: unknown[]) => {
            calls.push({ table, op, args })
            if (['select', 'delete', 'insert', 'upsert', 'update'].includes(op)) state.op = op
            return builder
        }
        for (const op of ['select', 'delete', 'insert', 'upsert', 'update', 'like', 'in', 'eq', 'order', 'limit']) builder[op] = chain(op)
        const resolve = () => results[`${table}.${state.op}`] ?? { data: null, error: null, count: 0 }
        builder.maybeSingle = async () => resolve()
        builder.single = async () => resolve()
        builder.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
            Promise.resolve(resolve()).then(onFulfilled, onRejected)
        return builder
    }
    return { from, calls }
}

describe('deletePlayersWithReferences', () => {
    it('removes every referencing row before the player rows, children first', async () => {
        const client = fakeClient({
            'players.select': { data: [{ id: 'p1' }, { id: 'p2' }], error: null },
            'roster_players.delete': { error: null, count: 2 },
        })

        const result = await deletePlayersWithReferences(client, { sportsdataIdLike: 'perpetual-%' })

        const deletes = client.calls.filter((c) => c.op === 'delete').map((c) => c.table)
        expect(deletes.at(-1)).toBe('players')
        expect(deletes.slice(0, -1)).toEqual(PLAYER_REFERENCE_TABLES.map((t) => t.table))
        expect(deletes.indexOf('trade_drop_reservations')).toBeLessThan(deletes.indexOf('roster_players'))
        expect(deletes.indexOf('roster_players')).toBeLessThan(deletes.indexOf('players'))
        expect(result.playerIds).toEqual(['p1', 'p2'])
        expect(result.deleted['roster_players.player_id']).toBe(2)
        const inFilters = client.calls.filter((c) => c.op === 'in')
        expect(inFilters.every((c) => JSON.stringify(c.args[1]) === JSON.stringify(['p1', 'p2']))).toBe(true)
    })

    it('touches nothing when no harness players exist', async () => {
        const client = fakeClient({ 'players.select': { data: [], error: null } })
        const result = await deletePlayersWithReferences(client, { sportsdataIdLike: 'perpetual-%' })
        expect(result.playerIds).toEqual([])
        expect(client.calls.some((c) => c.op === 'delete')).toBe(false)
    })

    it('names the table that refused the delete', async () => {
        const client = fakeClient({
            'players.select': { data: [{ id: 'p1' }], error: null },
            'waiver_wire_log.delete': { error: { message: 'boom' }, count: null },
        })
        await expect(deletePlayersWithReferences(client, { sportsdataIdLike: 'x%', label: 'cleanup' }))
            .rejects.toThrow(/cleanup waiver_wire_log\.player_id: boom/)
    })
})

describe('ensureRosterFixture', () => {
    const args = { leagueId: 'L', leagueSeasonId: 'S', memberId: 'M' }

    it('inserts a seeded e2e player when the roster is empty', async () => {
        const client = fakeClient({
            'roster_players.select': { data: null, error: null },
            'players.select': { data: { id: 'e2e-1' }, error: null },
            'roster_players.insert': { error: null },
        })
        const result = await ensureRosterFixture(client, args)
        expect(result).toEqual({ playerId: 'e2e-1', inserted: true })
        const like = client.calls.find((c) => c.table === 'players' && c.op === 'like')
        expect(like?.args).toEqual(['sportsdata_id', 'e2e-player-%'])
        const insert = client.calls.find((c) => c.table === 'roster_players' && c.op === 'insert')
        expect(insert?.args[0]).toMatchObject({ league_id: 'L', league_season_id: 'S', member_id: 'M', player_id: 'e2e-1' })
    })

    it('is a no-op when the member already has a rostered player', async () => {
        const client = fakeClient({ 'roster_players.select': { data: { player_id: 'have' }, error: null } })
        const result = await ensureRosterFixture(client, args)
        expect(result).toEqual({ playerId: 'have', inserted: false })
        expect(client.calls.some((c) => c.op === 'insert')).toBe(false)
    })

    it('fails loudly when the seed has not run', async () => {
        const client = fakeClient({ 'roster_players.select': { data: null, error: null }, 'players.select': { data: null, error: null } })
        await expect(ensureRosterFixture(client, args)).rejects.toThrow(/no seeded player .*e2e:seed/)
    })
})

describe('browser smoke roster readiness contract', () => {
    it('ensures the roster fixture in tab-only mode, not just the full sweep', async () => {
        const { readFile } = await import('node:fs/promises')
        const source = await readFile('tests/e2e/browser-smoke.mjs', 'utf8')
        expect(source).toMatch(/} else \{\s*\/\/ Tab smoke[\s\S]*ensureTabSmokeRosterReadiness\(env, state, user\)/)
        expect(source).not.toMatch(/order\('display_name'/)
    })

    it('cleans harness players through the FK-ordered helper', async () => {
        const { readFile } = await import('node:fs/promises')
        const source = await readFile('tests/e2e/perpetual-season.mjs', 'utf8')
        expect(source).toContain("deletePlayersWithReferences(supabase, { sportsdataIdLike: 'perpetual-%'")
        expect(source).not.toMatch(/from\('players'\)\s*\.delete\(\)/)
    })
})

describe('harness cleanup table list', () => {
    it('lists only tables the migration set still has', async () => {
        const { readdir, readFile } = await import('node:fs/promises')
        const dir = 'supabase/migrations'
        const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
        const created = new Set<string>()
        const dropped = new Set<string>()
        for (const file of files) {
            const sql = await readFile(`${dir}/${file}`, 'utf8')
            for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?([a-z_]+)/gi)) { created.add(m[1]); dropped.delete(m[1]) }
            for (const m of sql.matchAll(/DROP TABLE(?: IF EXISTS)?\s+(?:public\.)?([a-z_]+)/gi)) dropped.add(m[1])
        }
        for (const { table } of PLAYER_REFERENCE_TABLES) {
            expect(created.has(table), `${table} was never created`).toBe(true)
            expect(dropped.has(table), `${table} was dropped by a migration`).toBe(false)
        }
    })

    // Review round 2, S9: derive the set of live tables that reference players
    // without ON DELETE from the migrations themselves, so a new plain foreign
    // key to players cannot appear without the cleanup list going red.
    it('covers every live table with a plain foreign key to players', async () => {
        const { readdir, readFile } = await import('node:fs/promises')
        const dir = 'supabase/migrations'
        const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
        const referencing = new Set<string>()
        const dropped = new Set<string>()
        for (const file of files) {
            const sql = await readFile(`${dir}/${file}`, 'utf8')
            let table: string | null = null
            const lines = sql.split('\n').map((raw) => raw.replace(/--.*$/, ''))
            for (let index = 0; index < lines.length; index += 1) {
                const line = lines[index]
                const create = line.match(/CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?([a-z_]+)/i)
                const alter = line.match(/ALTER TABLE(?: ONLY)?(?: IF EXISTS)?\s+(?:public\.)?([a-z_]+)/i)
                if (create) { table = create[1]; dropped.delete(table) }
                else if (alter) table = alter[1]
                const drop = line.match(/DROP TABLE(?: IF EXISTS)?\s+(?:public\.)?([a-z_]+)/i)
                if (drop) { dropped.add(drop[1]); continue }
                // "REFERENCES players" with or without "(id)"; the ON DELETE clause may
                // sit on the next line. Only CASCADE / SET NULL / SET DEFAULT remove the
                // row automatically; RESTRICT and NO ACTION block the delete like the default.
                if (table && /REFERENCES\s+(?:public\.)?players\b/i.test(line)) {
                    const clause = `${line} ${lines[index + 1] ?? ''}`
                    if (!/ON DELETE\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT)/i.test(clause)) referencing.add(table)
                }
            }
        }
        for (const t of dropped) referencing.delete(t)
        const listed = new Set(PLAYER_REFERENCE_TABLES.map((t) => t.table))
        expect([...referencing].sort()).toEqual([...listed].sort())
    })
})

describe('dynasty ranking seed fixtures', () => {
    it('builds synthetic hashtag rows in the high rank band tagged with the e2e player id', async () => {
        const { buildDynastyRankingFixtures, DYNASTY_FIXTURE_RANK_BASE } = await import('./e2e/seed-league.mjs')
        const rows = buildDynastyRankingFixtures([
            { id: 'p1', sportsdata_id: 'e2e-player-001', first_name: 'E2E', last_name: 'Player001', eligible_positions: ['PG'], nba_team: 'ATL' },
            { id: 'p2', sportsdata_id: 'e2e-player-002', first_name: 'E2E', last_name: 'Player002', eligible_positions: ['SG'], nba_team: null },
        ], '2026-09-12T00:00:00.000Z')
        expect(rows.map((r: { source_rank: number }) => r.source_rank)).toEqual([DYNASTY_FIXTURE_RANK_BASE + 1, DYNASTY_FIXTURE_RANK_BASE + 2])
        expect(rows.every((r: { source: string; source_player_id: string }) => r.source === 'hashtagbasketball.com' && r.source_player_id.startsWith('e2e-'))).toBe(true)
        expect(rows[0]).toMatchObject({ player_id: 'p1', source_player_name: 'E2E Player001', source_team: 'ATL', scoring_format: 'overall' })
        expect(rows[1].source_team).toBeNull()
    })
})
