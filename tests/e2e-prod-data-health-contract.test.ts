import { describe, expect, it } from 'vitest'
import {
    evaluateCrudReadiness,
    evaluateProductionDataHealth,
    productionDataThresholds,
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
})
