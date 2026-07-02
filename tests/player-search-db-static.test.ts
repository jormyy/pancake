import { describe, expect, it } from 'vitest'
import { latestFunctionDefinition, read } from './source-guard'

describe('player search database contract', () => {
    it('starts from players and left-joins stats so no-stat players remain searchable', () => {
        const body = latestFunctionDefinition('search_players')

        expect(body).toContain('"position" text')
        expect(body).toContain('p.position::text AS "position"')
        expect(body).toContain('JOIN public.players AS p ON true')
        expect(body).toContain('LEFT JOIN public.mv_player_season_averages AS avg')
        expect(body).toContain('LEFT JOIN public.v_player_avg_fantasy_points AS fp')
        expect(body).not.toContain('players!inner')
    })

    it('treats an active but empty playing-team scope as zero results', () => {
        const body = latestFunctionDefinition('search_players')

        expect(body).toContain("WHEN p_playing_teams IS NOT NULL AND cardinality(COALESCE(p_teams, '{}')) > 0 THEN")
        expect(body).toContain("WHEN p_playing_teams IS NOT NULL THEN COALESCE(p_playing_teams, '{}')")
        expect(body).not.toContain("p_playing_teams IS NOT NULL AND cardinality(COALESCE(p_playing_teams, '{}')) > 0")
        expect(body).toContain("(p_playing_teams IS NOT NULL OR cardinality(COALESCE(p_teams, '{}')) > 0) AS team_filter_active")
        expect(body).toContain('(NOT args.team_filter_active OR (cardinality(args.effective_teams) > 0 AND p.nba_team = ANY(args.effective_teams)))')
    })

    it('adds high-load indexes for name search and stat sorting', () => {
        const migration = read('supabase/migrations/20260629000001_player_search_dynasty_news.sql')
        const perfMigration = read('supabase/migrations/20260702000001_player_search_performance_cache.sql')

        expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm')
        expect(migration).toContain('idx_players_display_name_trgm')
        expect(migration).toContain('idx_mv_player_search_points')
        expect(migration).toContain('idx_mv_player_search_misc')
        expect(perfMigration).toContain('CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_player_avg_fantasy_points')
        expect(perfMigration).toContain('idx_mv_player_avg_fantasy_points_sort')
        expect(perfMigration).toContain('refresh-player-search-caches')
    })

    it('paginates before projection enrichment so player search stays bounded', () => {
        const body = latestFunctionDefinition('search_players')

        expect(body).toContain('paged_base AS')
        expect(body).toContain('FROM paged_base pb')
        expect(body).toContain('row_number() OVER')
        expect(body).toContain('ORDER BY pb.page_rank')
        expect(body).toContain('COALESCE((SELECT array_agg(paged_base.id ORDER BY paged_base.id) FROM paged_base), ARRAY[]::uuid[])')
        expect(body).not.toContain('COALESCE((SELECT array_agg(filtered_base.id ORDER BY filtered_base.id) FROM filtered_base), ARRAY[]::uuid[])')
    })

    it('backs Dynasty Hub news with a read-only client table', () => {
        const migration = read('supabase/migrations/20260629000001_player_search_dynasty_news.sql')

        expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.dynasty_news')
        expect(migration).toContain('ALTER TABLE public.dynasty_news ENABLE ROW LEVEL SECURITY')
        expect(migration).toContain('GRANT SELECT ON public.dynasty_news TO authenticated')
        expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.dynasty_news TO service_role')
    })
})
