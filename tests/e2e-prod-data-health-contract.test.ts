import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import {
    evaluateCrudReadiness,
    evaluateProductionDataHealth,
    productionDataThresholds,
    runCleanupBackedCrudProbe,
} from './e2e/prod-data-health-contract.mjs'

const healthy = (fetchedAt: string) => ({
    nba_games: 1200,
    final_games_without_stats: 0,
    final_missing_stats_rpc: 0,
    games_missing_nba_game_id: 0,
    players: 500,
    projections: 500,
    latest_projection_fetch: fetchedAt,
    open_sync_jobs: 0,
})

describe('production data health contract', () => {
    it.each([
        ['tests/e2e/prod-data-source-health.mjs', 'CORE_TABLES'],
        ['tests/e2e/seed-league.mjs', 'LEAGUE_MEMBER_DEPENDENT_TABLES'],
    ])('%s references only current public tables', (file, list) => {
        const database = ts.createSourceFile('database.ts', readFileSync('types/database.ts', 'utf8'), ts.ScriptTarget.Latest, true)
        const declaration = database.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'Database')
        if (!declaration || !ts.isTypeAliasDeclaration(declaration) || !ts.isTypeLiteralNode(declaration.type)) throw new Error('Database type missing')
        const member = (node: ts.TypeLiteralNode, name: string) => {
            const property = node.members.find(item => ts.isPropertySignature(item) && item.name.getText(database) === name)
            if (!property || !ts.isPropertySignature(property) || !property.type || !ts.isTypeLiteralNode(property.type)) throw new Error(`${name} type missing`)
            return property.type
        }
        const tables = member(member(declaration.type, 'public'), 'Tables').members.map(node => node.name?.getText(database))
        const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
        const declarations = source.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
        const values = declarations.find(node => node.name.getText(source) === list)?.initializer
        if (!values || !ts.isArrayLiteralExpression(values)) throw new Error(`${list} missing`)
        expect(values.elements.length).toBeGreaterThan(0)
        expect(values.elements.map(node => {
            if (!ts.isStringLiteral(node)) throw new Error('Expected a table name')
            return node.text
        }).filter(name => !tables.includes(name))).toEqual([])
    })

    it('scopes projection count and freshness to the computed current season', () => {
        const source = readFileSync('tests/e2e/prod-data-source-health.mjs', 'utf8')
        expect(source).toContain('player_projections p, season s WHERE p.season_year = s.season_year')
    })

    it('blocks empty and null production datasets', () => {
        const result = evaluateProductionDataHealth({
            nba_games: 0,
            final_games_without_stats: 0,
            final_missing_stats_rpc: 0,
            games_missing_nba_game_id: 0,
            players: 0,
            projections: 0,
            latest_projection_fetch: null,
            open_sync_jobs: 0,
        }, new Date('2026-02-10T12:00:00Z'))

        expect(result.failures).toEqual(expect.arrayContaining([
            expect.stringContaining('players'),
            expect.stringContaining('current-season games'),
            expect.stringContaining('projections'),
            'latest projection fetch is missing or invalid',
        ]))
    })

    it('uses tighter active-season and wider offseason projection freshness', () => {
        expect(productionDataThresholds(new Date('2026-02-10T12:00:00Z')).maxProjectionAgeDays).toBe(7)
        expect(productionDataThresholds(new Date('2026-08-10T12:00:00Z')).maxProjectionAgeDays).toBe(45)
        expect(evaluateProductionDataHealth(
            healthy('2026-02-02T00:00:00Z'),
            new Date('2026-02-10T12:00:00Z'),
        ).failures.some((failure: string) => failure.includes('latest projection fetch is'))).toBe(true)
        expect(evaluateProductionDataHealth(
            healthy('2026-07-01T00:00:00Z'),
            new Date('2026-08-10T12:00:00Z'),
        ).failures).toEqual([])
    })

    it('blocks missing game identifiers and active sync jobs', () => {
        expect(evaluateProductionDataHealth({
            ...healthy('2026-02-09T00:00:00Z'),
            games_missing_nba_game_id: 1,
            open_sync_jobs: 2,
        }, new Date('2026-02-10T12:00:00Z')).failures).toEqual(expect.arrayContaining([
            '1 current-season games are missing nba_game_id',
            '2 sync jobs are still open',
        ]))
    })

    it('never records a disabled or incomplete CRUD probe as ready', () => {
        expect(evaluateCrudReadiness(false, null)).toMatchObject({ pass: false })
        expect(evaluateCrudReadiness(true, { inserted: 1, updated: 1, deleted: 1, residue: 0 })).toMatchObject({ pass: true })
        expect(evaluateCrudReadiness(true, { inserted: 1, updated: 0, deleted: 1, residue: 0 })).toMatchObject({ pass: false })
    })

    it('cleans the sentinel row when a CRUD step fails', () => {
        const calls: string[] = []
        const query = (_label: string, sql: string) => {
            calls.push(sql)
            if (sql.startsWith('UPDATE')) throw new Error('injected update failure')
            return [{ lock_key: -1 }]
        }

        expect(() => runCleanupBackedCrudProbe(query, -1)).toThrow('injected update failure')
        expect(calls.at(-1)).toContain('DELETE FROM public.live_poll_leases')
    })
})
