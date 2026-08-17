import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))
import {
    dynastyAnalyzerSnapshotCacheKey,
    dynastyDecisionCacheKey,
    playerAssetFromDecisionInput,
    scoringSettingsFromJson,
    type DynastyDecisionInput,
} from '@/lib/dynasty-decisions'

describe('dynasty decision data contract', () => {
    it('isolates rankings by user, member, league, season, strategy, and query', () => {
        const base = {
            userId: 'user-a', memberId: 'member-a', leagueId: 'league-a', seasonYear: 2026,
            strategy: 'overall' as const, query: ' Young Star ',
        }
        const key = dynastyDecisionCacheKey(base)

        expect(key).not.toBe(dynastyDecisionCacheKey({ ...base, userId: 'user-b' }))
        expect(key).not.toBe(dynastyDecisionCacheKey({ ...base, memberId: 'member-b' }))
        expect(key).not.toBe(dynastyDecisionCacheKey({ ...base, leagueId: 'league-b' }))
        expect(key).not.toBe(dynastyDecisionCacheKey({ ...base, seasonYear: 2027 }))
        expect(key).not.toBe(dynastyDecisionCacheKey({ ...base, strategy: 'rebuild' }))
        expect(key).not.toBe(dynastyDecisionCacheKey({ ...base, query: 'Veteran' }))
        expect(key).toContain('young%20star')
    })

    it('isolates Analyzer snapshots by user, member, and league', () => {
        const key = dynastyAnalyzerSnapshotCacheKey('user-a', 'member-a', 'league-a')
        expect(key).not.toBe(dynastyAnalyzerSnapshotCacheKey('user-b', 'member-a', 'league-a'))
        expect(key).not.toBe(dynastyAnalyzerSnapshotCacheKey('user-a', 'member-b', 'league-a'))
        expect(key).not.toBe(dynastyAnalyzerSnapshotCacheKey('user-a', 'member-a', 'league-b'))
    })

    it('drops non-numeric scoring values', () => {
        expect(scoringSettingsFromJson({ points: 1, assists: 1.5, label: 'bad', nested: { x: 1 } })).toEqual({
            points: 1,
            assists: 1.5,
        })
    })

    it('maps one batched row into the shared engine input', () => {
        const row = {
            player_id: 'player-1', display_name: 'Player One', age: 22, dynasty_rank: 8,
            rank_change: 2, injury_status: null, avg_fantasy_points: 41,
            projection_fantasy_points: 44, years_exp: 0, ranking_source: 'rankings',
            ranking_fetched_at: '2026-08-16T00:00:00Z', projection_source: 'projections',
            projection_fetched_at: '2026-08-16T01:00:00Z',
        } as unknown as DynastyDecisionInput

        expect(playerAssetFromDecisionInput(row)).toMatchObject({
            kind: 'player', id: 'player-1', label: 'Player One', age: 22, dynastyRank: 8,
            rankMovement: 2, productionFantasyPoints: 41, projectionFantasyPoints: 44, isRookie: true,
        })
    })
})
