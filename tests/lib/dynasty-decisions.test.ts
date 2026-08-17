import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))
import {
    dynastyAnalyzerSnapshotCacheKey,
    dynastyAnalyzerLatestScopeCacheKey,
    dynastyAnalyzerRouteSignature,
    dynastyDecisionCacheKey,
    dynastyScoringSignature,
    playerAssetFromDecisionInput,
    scoringSettingsFromJson,
    type DynastyDecisionInput,
} from '@/lib/dynasty-decisions'

describe('dynasty decision data contract', () => {
    it('isolates ranking snapshots by user, member, league, season, and scoring', () => {
        const base = {
            userId: 'user-a', memberId: 'member-a', leagueId: 'league-a', seasonYear: 2026,
            scoringSignature: '[["points",1]]',
        }
        const key = dynastyDecisionCacheKey(base)

        expect(key).not.toBe(dynastyDecisionCacheKey({ ...base, userId: 'user-b' }))
        expect(key).not.toBe(dynastyDecisionCacheKey({ ...base, memberId: 'member-b' }))
        expect(key).not.toBe(dynastyDecisionCacheKey({ ...base, leagueId: 'league-b' }))
        expect(key).not.toBe(dynastyDecisionCacheKey({ ...base, seasonYear: 2027 }))
        expect(key).not.toBe(dynastyDecisionCacheKey({ ...base, scoringSignature: '[["points",2]]' }))
    })

    it('isolates Analyzer snapshots by identity and route', () => {
        const scope = {
            userId: 'user-a', memberId: 'member-a', leagueId: 'league-a', seasonYear: 2026,
            scoringSignature: '[["points",1]]', teams: 12, faabBudget: 100,
        }
        const route = 'member-a>member-b:player:p1'
        const key = dynastyAnalyzerSnapshotCacheKey(scope, route)
        expect(key).not.toBe(dynastyAnalyzerSnapshotCacheKey({ ...scope, userId: 'user-b' }, route))
        expect(key).not.toBe(dynastyAnalyzerSnapshotCacheKey({ ...scope, memberId: 'member-b' }, route))
        expect(key).not.toBe(dynastyAnalyzerSnapshotCacheKey({ ...scope, leagueId: 'league-b' }, route))
        expect(key).not.toBe(dynastyAnalyzerSnapshotCacheKey({ ...scope, seasonYear: 2027 }, route))
        expect(key).not.toBe(dynastyAnalyzerSnapshotCacheKey({ ...scope, scoringSignature: '[["points",2]]' }, route))
        expect(key).not.toBe(dynastyAnalyzerSnapshotCacheKey({ ...scope, teams: 10 }, route))
        expect(key).not.toBe(dynastyAnalyzerSnapshotCacheKey({ ...scope, faabBudget: 200 }, route))
        expect(key).not.toBe(dynastyAnalyzerSnapshotCacheKey(scope, 'other-route'))
        expect(dynastyAnalyzerRouteSignature([
            { kind: 'pick', fromMemberId: 'b', toMemberId: 'a', pickId: 'pick' },
            { kind: 'player', fromMemberId: 'a', toMemberId: 'b', playerId: 'player' },
        ])).toBe('a>b:player:player|b>a:pick:pick')
        expect(dynastyAnalyzerLatestScopeCacheKey(scope)).not.toBe(
            dynastyAnalyzerLatestScopeCacheKey({ ...scope, leagueId: 'league-b' }),
        )
    })

    it('drops non-numeric scoring values', () => {
        expect(scoringSettingsFromJson({ points: 1, assists: 1.5, label: 'bad', nested: { x: 1 } })).toEqual({
            points: 1,
            assists: 1.5,
        })
    })

    it('creates a stable scoring signature', () => {
        expect(dynastyScoringSignature({ points: 1, assists: 1.5 })).toBe(
            dynastyScoringSignature({ assists: 1.5, points: 1 }),
        )
        expect(dynastyScoringSignature({ points: 1 })).not.toBe(dynastyScoringSignature({ points: 2 }))
    })

    it('maps one batched row into the shared engine input', () => {
        const row = {
            player_id: 'player-1', display_name: 'Player One', age: 22, five_year_rank: 8,
            three_year_rank: 12,
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
