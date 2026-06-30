import { describe, expect, it } from 'vitest'
import { read } from './source-guard'

const migration = read('supabase/migrations/20260630000002_replace_dynasty_rankings_rpc.sql')

describe('dynasty ranking replacement RPC static guards', () => {
    it('fails closed on malformed or undersized ranking payloads', () => {
        expect(migration).toContain("jsonb_typeof(p_rows) <> 'array'")
        expect(migration).toContain('jsonb_array_length(p_rows)')
        expect(migration).toContain('Ranking row count % is below minimum %')
        expect(migration).toContain('v_stage_count <> v_payload_count')
    })

    it('rejects invalid or duplicate ranks before replacing current rows', () => {
        expect(migration).toContain('source_rank IS NULL OR source_rank <= 0 OR source_player_name IS NULL')
        expect(migration).toContain('GROUP BY source_rank')
        expect(migration).toContain('HAVING count(*) > 1')
        expect(migration).toContain('Ranking payload contains duplicate source ranks')
    })

    it('upserts rows, deletes stale source rows, and clears stale player ranks in one RPC body', () => {
        const upsertIndex = migration.indexOf('ON CONFLICT (source, source_rank) DO UPDATE SET')
        const deleteIndex = migration.indexOf('DELETE FROM public.dynasty_rankings AS ranking')
        const clearIndex = migration.indexOf('UPDATE public.players AS player\n     SET dynasty_rank = NULL')

        expect(upsertIndex).toBeGreaterThan(0)
        expect(deleteIndex).toBeGreaterThan(upsertIndex)
        expect(clearIndex).toBeGreaterThan(deleteIndex)
        expect(migration).toContain('WHERE ranking.source = v_source')
        expect(migration).toContain('player.dynasty_rank_source = v_source')
    })

    it('uses one best source rank per matched player when updating players', () => {
        expect(migration).toContain('SELECT DISTINCT ON (player_id)')
        expect(migration).toContain('ORDER BY player_id, source_rank')
        expect(migration).toContain('SET dynasty_rank = best_rank.source_rank')
    })

    it('keeps the replacement RPC service-role only', () => {
        expect(migration).toContain('SECURITY DEFINER')
        expect(migration).toContain('REVOKE ALL ON FUNCTION public.replace_dynasty_rankings(text, timestamptz, jsonb, int) FROM authenticated')
        expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.replace_dynasty_rankings(text, timestamptz, jsonb, int) TO service_role')
    })
})
