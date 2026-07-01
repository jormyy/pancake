import { describe, expect, it } from 'vitest'
import { functionPrivilegeStatements, latestFunctionDefinition, read } from './source-guard'

const activeReplacementRpc = latestFunctionDefinition('replace_dynasty_rankings')
const metadataMigration = read('supabase/migrations/20260630000003_dynasty_rankings_points_metadata.sql')
const replayMigration = read('supabase/migrations/20260630000021_replay_dynasty_ranking_rpc.sql')
const syncFunction = read('supabase/functions/sync-rankings/index.ts')

describe('dynasty ranking replacement RPC static guards', () => {
    it('fails closed on malformed or undersized ranking payloads', () => {
        expect(activeReplacementRpc).toContain("jsonb_typeof(p_rows) <> 'array'")
        expect(activeReplacementRpc).toContain('jsonb_array_length(p_rows)')
        expect(activeReplacementRpc).toContain('Ranking row count % is below minimum %')
        expect(activeReplacementRpc).toContain('v_stage_count <> v_payload_count')
    })

    it('rejects invalid or duplicate ranks before replacing current rows', () => {
        expect(activeReplacementRpc).toContain('source_rank IS NULL OR source_rank <= 0 OR source_player_name IS NULL')
        expect(activeReplacementRpc).toContain('GROUP BY (item ->> ')
        expect(activeReplacementRpc).toContain('HAVING count(*) > 1')
        expect(activeReplacementRpc).toContain('Ranking payload contains duplicate source ranks')
    })

    it('upserts rows, deletes stale source rows, and clears stale player ranks in one RPC body', () => {
        const upsertIndex = activeReplacementRpc.indexOf('ON CONFLICT (source, source_rank) DO UPDATE SET')
        const deleteIndex = activeReplacementRpc.indexOf('DELETE FROM public.dynasty_rankings AS ranking')
        const clearIndex = activeReplacementRpc.indexOf('UPDATE public.players AS player\n     SET dynasty_rank = NULL')

        expect(upsertIndex).toBeGreaterThan(0)
        expect(deleteIndex).toBeGreaterThan(upsertIndex)
        expect(clearIndex).toBeGreaterThan(deleteIndex)
        expect(activeReplacementRpc).toContain('WHERE ranking.source = v_source')
        expect(activeReplacementRpc).toContain('player.dynasty_rank_source = v_source')
    })

    it('uses one best source rank per matched player when updating players', () => {
        expect(activeReplacementRpc).toContain('SELECT DISTINCT ON (player_id)')
        expect(activeReplacementRpc).toContain('ORDER BY player_id, source_rank')
        expect(activeReplacementRpc).toContain('SET dynasty_rank = best_rank.source_rank')
    })

    it('keeps the replacement RPC service-role only', () => {
        const privilegeStatements = functionPrivilegeStatements('replace_dynasty_rankings')

        expect(activeReplacementRpc).toContain('SECURITY DEFINER')
        expect(privilegeStatements.some((stmt) =>
            stmt.includes('replace_dynasty_rankings(text, timestamptz, jsonb, int, text, text, jsonb)') &&
            stmt.includes('FROM authenticated'),
        )).toBe(true)
        expect(privilegeStatements.some((stmt) =>
            stmt.includes('replace_dynasty_rankings(text, timestamptz, jsonb, int, text, text, jsonb)') &&
            stmt.includes('TO service_role'),
        )).toBe(true)
    })

    it('requests Hashtag points-league dynasty rankings before falling back', () => {
        expect(syncFunction).toContain("const POINTS_RANKING_TYPE = 'POINT'")
        expect(syncFunction).toContain("form.set('ctl00$ContentPlaceHolder1$DDTYPE', POINTS_RANKING_TYPE)")
        expect(syncFunction).toContain("selectedType === POINTS_RANKING_TYPE")
        expect(syncFunction).toContain("scoringFormat: 'points'")
        expect(syncFunction).toContain('fallbackReason')
    })

    it('stores dynasty ranking source scoring metadata with the replacement RPC', () => {
        expect(metadataMigration).toContain('ADD COLUMN IF NOT EXISTS scoring_format text NOT NULL DEFAULT')
        expect(metadataMigration).toContain('ADD COLUMN IF NOT EXISTS source_url text')
        expect(metadataMigration).toContain('ADD COLUMN IF NOT EXISTS source_metadata jsonb NOT NULL')
        expect(metadataMigration).toContain("CHECK (scoring_format IN ('overall', 'points', 'category', 'custom'))")
        expect(metadataMigration).toContain('p_scoring_format text DEFAULT')
        expect(metadataMigration).toContain('p_source_url text DEFAULT NULL')
        expect(metadataMigration).toContain("p_source_metadata jsonb DEFAULT '{}'::jsonb")
        expect(metadataMigration).toContain('ON CONFLICT (source, source_rank) DO UPDATE SET')
        expect(metadataMigration).toContain('scoring_format = EXCLUDED.scoring_format')
        expect(metadataMigration).toContain('source_metadata = EXCLUDED.source_metadata')
        expect(metadataMigration).toContain('GRANT EXECUTE ON FUNCTION public.replace_dynasty_rankings(text, timestamptz, jsonb, int, text, text, jsonb) TO service_role')
        expect(replayMigration).toContain('Prod replay')
        expect(replayMigration).toContain('CREATE OR REPLACE FUNCTION public.replace_dynasty_rankings')
        expect(replayMigration).toContain('p_source_metadata jsonb DEFAULT')
        expect(replayMigration).toContain('GRANT EXECUTE ON FUNCTION public.replace_dynasty_rankings(text, timestamptz, jsonb, int, text, text, jsonb) TO service_role')
    })
})
