CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_players_display_name_trgm
  ON public.players USING gin (display_name extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_players_search_team_exp
  ON public.players (nba_team, years_exp, last_name);

CREATE INDEX IF NOT EXISTS idx_mv_player_search_points
  ON analytics.mv_player_season_averages (season_year, avg_points, player_id);

CREATE INDEX IF NOT EXISTS idx_mv_player_search_rebounds
  ON analytics.mv_player_season_averages (season_year, avg_rebounds, player_id);

CREATE INDEX IF NOT EXISTS idx_mv_player_search_assists
  ON analytics.mv_player_season_averages (season_year, avg_assists, player_id);

CREATE INDEX IF NOT EXISTS idx_mv_player_search_defense
  ON analytics.mv_player_season_averages (season_year, avg_steals, avg_blocks, player_id);

CREATE INDEX IF NOT EXISTS idx_mv_player_search_misc
  ON analytics.mv_player_season_averages (season_year, avg_three_pointers_made, avg_turnovers, games_played, player_id);

CREATE OR REPLACE FUNCTION public.search_players(
  p_query text DEFAULT '',
  p_position text DEFAULT 'ALL',
  p_teams text[] DEFAULT '{}',
  p_league_id uuid DEFAULT NULL,
  p_playing_teams text[] DEFAULT NULL,
  p_excluded_teams text[] DEFAULT '{}',
  p_include_player_ids uuid[] DEFAULT NULL,
  p_exclude_player_ids uuid[] DEFAULT '{}',
  p_rookies_only boolean DEFAULT false,
  p_health text DEFAULT 'all',
  p_sort_by text DEFAULT 'fpts',
  p_sort_dir text DEFAULT 'desc',
  p_season_year int DEFAULT public.current_season_year_et(),
  p_limit int DEFAULT 60,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  display_name text,
  nba_team text,
  "position" text,
  eligible_positions text[],
  status text,
  injury_status text,
  headshot_url text,
  nba_id text,
  years_exp int,
  avg_fantasy_points numeric,
  avg_points numeric,
  avg_rebounds numeric,
  avg_assists numeric,
  avg_steals numeric,
  avg_blocks numeric,
  avg_turnovers numeric,
  avg_three_pointers_made numeric,
  avg_minutes_played numeric,
  games_played int
)
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $$
WITH args AS (
  SELECT
    NULLIF(trim(COALESCE(p_query, '')), '') AS query_text,
    CASE COALESCE(p_position, 'ALL')
      WHEN 'ALL' THEN ARRAY[]::text[]
      WHEN 'G' THEN ARRAY['PG', 'SG']::text[]
      WHEN 'F' THEN ARRAY['SF', 'PF']::text[]
      ELSE ARRAY[p_position]::text[]
    END AS pos_filter,
    CASE
      WHEN p_playing_teams IS NOT NULL AND cardinality(COALESCE(p_teams, '{}')) > 0 THEN
          ARRAY(
            SELECT explicit_team
            FROM unnest(COALESCE(p_teams, '{}')) AS explicit_team
            WHERE explicit_team = ANY(COALESCE(p_playing_teams, '{}'))
            ORDER BY explicit_team
          )
      WHEN p_playing_teams IS NOT NULL THEN COALESCE(p_playing_teams, '{}')
      ELSE COALESCE(p_teams, '{}')
    END AS effective_teams,
    (p_playing_teams IS NOT NULL OR cardinality(COALESCE(p_teams, '{}')) > 0) AS team_filter_active,
    COALESCE(p_excluded_teams, '{}') AS excluded_teams,
    COALESCE(p_exclude_player_ids, '{}') AS exclude_player_ids,
    LEAST(GREATEST(COALESCE(p_limit, 60), 1), 100) AS page_limit,
    GREATEST(COALESCE(p_offset, 0), 0) AS page_offset
),
filtered AS (
  SELECT
    p.id,
    COALESCE(p.display_name, concat_ws(' ', p.first_name, p.last_name)) AS display_name,
    p.nba_team,
    p.position::text AS "position",
    ARRAY(SELECT pos::text FROM unnest(p.eligible_positions) AS pos) AS eligible_positions,
    p.status,
    p.injury_status,
    p.headshot_url,
    p.nba_id,
    p.years_exp,
    COALESCE(fp.avg_fantasy_points, avg.avg_points) AS avg_fantasy_points,
    avg.avg_points,
    avg.avg_rebounds,
    avg.avg_assists,
    avg.avg_steals,
    avg.avg_blocks,
    avg.avg_turnovers,
    avg.avg_three_pointers_made,
    avg.avg_minutes_played,
    avg.games_played::int AS games_played
  FROM args
  JOIN public.players AS p ON true
  LEFT JOIN public.mv_player_season_averages AS avg
    ON avg.player_id = p.id
   AND avg.season_year = p_season_year
  LEFT JOIN public.v_player_avg_fantasy_points AS fp
    ON fp.player_id = p.id
   AND fp.season_year = p_season_year
   AND fp.league_id = p_league_id
  WHERE
    (args.query_text IS NULL OR p.display_name ILIKE ('%' || args.query_text || '%'))
    AND (cardinality(args.pos_filter) = 0 OR EXISTS (
      SELECT 1
      FROM unnest(p.eligible_positions) AS player_position
      WHERE player_position::text = ANY(args.pos_filter)
    ))
    AND (NOT args.team_filter_active OR (cardinality(args.effective_teams) > 0 AND p.nba_team = ANY(args.effective_teams)))
    AND (cardinality(args.excluded_teams) = 0 OR p.nba_team IS NULL OR p.nba_team <> ALL(args.excluded_teams))
    AND (p_include_player_ids IS NULL OR p.id = ANY(p_include_player_ids))
    AND (cardinality(args.exclude_player_ids) = 0 OR p.id <> ALL(args.exclude_player_ids))
    AND (NOT p_rookies_only OR p.years_exp = 0)
    AND CASE COALESCE(p_health, 'all')
      WHEN 'healthy' THEN p.injury_status IS NULL
      WHEN 'gtd' THEN p.injury_status = ANY(ARRAY['GTD', 'DTD', 'Questionable', 'Game Time Decision'])
      WHEN 'out' THEN p.injury_status = ANY(ARRAY['Out', 'OUT', 'O'])
      WHEN 'ir' THEN p.injury_status = ANY(ARRAY['IR', 'IR-LTI'])
      ELSE true
    END
)
SELECT
  filtered.id,
  filtered.display_name,
  filtered.nba_team,
  filtered."position",
  filtered.eligible_positions,
  filtered.status,
  filtered.injury_status,
  filtered.headshot_url,
  filtered.nba_id,
  filtered.years_exp,
  filtered.avg_fantasy_points,
  filtered.avg_points,
  filtered.avg_rebounds,
  filtered.avg_assists,
  filtered.avg_steals,
  filtered.avg_blocks,
  filtered.avg_turnovers,
  filtered.avg_three_pointers_made,
  filtered.avg_minutes_played,
  filtered.games_played
FROM filtered
ORDER BY
  CASE WHEN p_sort_by = 'fpts' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_fantasy_points, 0) END ASC,
  CASE WHEN p_sort_by = 'fpts' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_fantasy_points, 0) END DESC,
  CASE WHEN p_sort_by = 'pts' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_points, 0) END ASC,
  CASE WHEN p_sort_by = 'pts' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_points, 0) END DESC,
  CASE WHEN p_sort_by = 'reb' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_rebounds, 0) END ASC,
  CASE WHEN p_sort_by = 'reb' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_rebounds, 0) END DESC,
  CASE WHEN p_sort_by = 'ast' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_assists, 0) END ASC,
  CASE WHEN p_sort_by = 'ast' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_assists, 0) END DESC,
  CASE WHEN p_sort_by = 'stl' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_steals, 0) END ASC,
  CASE WHEN p_sort_by = 'stl' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_steals, 0) END DESC,
  CASE WHEN p_sort_by = 'blk' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_blocks, 0) END ASC,
  CASE WHEN p_sort_by = 'blk' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_blocks, 0) END DESC,
  CASE WHEN p_sort_by = 'tpm' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_three_pointers_made, 0) END ASC,
  CASE WHEN p_sort_by = 'tpm' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_three_pointers_made, 0) END DESC,
  CASE WHEN p_sort_by = 'to' AND p_sort_dir = 'asc' THEN COALESCE(filtered.avg_turnovers, 0) END ASC,
  CASE WHEN p_sort_by = 'to' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.avg_turnovers, 0) END DESC,
  CASE WHEN p_sort_by = 'gp' AND p_sort_dir = 'asc' THEN COALESCE(filtered.games_played, 0) END ASC,
  CASE WHEN p_sort_by = 'gp' AND p_sort_dir <> 'asc' THEN COALESCE(filtered.games_played, 0) END DESC,
  filtered.display_name ASC,
  filtered.id ASC
LIMIT (SELECT page_limit FROM args)
OFFSET (SELECT page_offset FROM args);
$$;

REVOKE ALL ON FUNCTION public.search_players(text, text, text[], uuid, text[], text[], uuid[], uuid[], boolean, text, text, text, int, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_players(text, text, text[], uuid, text[], text[], uuid[], uuid[], boolean, text, text, text, int, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.search_players(text, text, text[], uuid, text[], text[], uuid[], uuid[], boolean, text, text, text, int, int, int) TO authenticated;

CREATE TABLE IF NOT EXISTS public.dynasty_news (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  summary text NOT NULL,
  source text NOT NULL,
  url text,
  published_at timestamptz NOT NULL DEFAULT now(),
  player_id uuid REFERENCES public.players(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dynasty_news_title_not_blank CHECK (length(trim(title)) > 0),
  CONSTRAINT dynasty_news_summary_not_blank CHECK (length(trim(summary)) > 0),
  CONSTRAINT dynasty_news_source_not_blank CHECK (length(trim(source)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_dynasty_news_published_at
  ON public.dynasty_news (published_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_dynasty_news_player
  ON public.dynasty_news (player_id, published_at DESC)
  WHERE player_id IS NOT NULL;

ALTER TABLE public.dynasty_news ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dynasty_news_select_authenticated ON public.dynasty_news;
CREATE POLICY dynasty_news_select_authenticated ON public.dynasty_news
  FOR SELECT TO authenticated USING (true);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.dynasty_news FROM anon, authenticated;
GRANT SELECT ON public.dynasty_news TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dynasty_news TO service_role;

COMMENT ON TABLE public.dynasty_news IS
  'Curated dynasty-player news for the Dynasty Hub tab. Authenticated clients read it; service-role sync/admin paths write it.';
