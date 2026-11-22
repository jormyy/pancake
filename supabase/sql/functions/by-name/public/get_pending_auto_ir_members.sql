-- Canonical SQL source for public.get_pending_auto_ir_members.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_pending_auto_ir_members(
  p_game_date date,
  p_tipoff_at timestamptz DEFAULT NULL,
  p_token uuid DEFAULT NULL,
  p_excluded_members uuid[] DEFAULT ARRAY[]::uuid[],
  p_limit int DEFAULT 100,
  p_include_enabled boolean DEFAULT false,
  p_scope text DEFAULT ''
)
RETURNS TABLE(league_id uuid, league_season_id uuid, member_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_dispatch public.lineup_tipoff_dispatches%ROWTYPE;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'Auto IR batch size must be positive' USING ERRCODE = '22023';
  END IF;
  IF p_game_date IS DISTINCT FROM (now() AT TIME ZONE 'America/New_York')::date THEN RETURN; END IF;
  IF p_tipoff_at IS NOT NULL THEN
    SELECT * INTO v_dispatch FROM public.lineup_tipoff_dispatches
      WHERE tipoff_at = p_tipoff_at AND scope = p_scope AND token = p_token AND status = 'running'
        AND lease_until > clock_timestamp() AND tipoff_at > clock_timestamp() - interval '1 minute'
        AND game_date = p_game_date FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Tipoff lease expired or changed' USING ERRCODE = '40001'; END IF;
  END IF;
  RETURN QUERY
  SELECT member.league_id, season.id, member.id
  FROM public.league_members member
  JOIN public.leagues league ON league.id = member.league_id AND league.status IN ('active', 'playoffs')
  JOIN public.league_seasons season ON season.league_id = league.id AND season.is_current
  JOIN private.league_roster_policies policy ON policy.league_id = league.id
    AND policy.auto_ir_all_members AND policy.ir_activated_at IS NOT NULL
  LEFT JOIN public.lineup_optimizer_settings setting
    ON setting.league_id = member.league_id AND setting.league_season_id = season.id
   AND setting.member_id = member.id
  WHERE (p_include_enabled OR NOT COALESCE(setting.enabled, false))
    AND NOT (member.id = ANY(COALESCE(p_excluded_members, ARRAY[]::uuid[])))
    AND (p_tipoff_at IS NULL OR private.tipoff_scope_admits(p_scope, member.league_id))
    AND (p_tipoff_at IS NULL OR EXISTS (
      SELECT 1 FROM public.nba_games game
      WHERE game.season_year = season.season_year AND game.game_date = p_game_date
        AND game.status = 'Scheduled'
        AND private.lineup_game_available(game.status, game.game_status_text)
        AND game.game_time = p_tipoff_at
    ))
    AND (p_tipoff_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.lineup_tipoff_members done
      WHERE done.tipoff_at = p_tipoff_at AND done.scope = p_scope AND done.league_id = member.league_id
        AND done.league_season_id = season.id AND done.member_id = member.id
        AND done.input_revision = v_dispatch.input_revision
        AND (done.ir_done OR done.error IS NOT NULL)
    ))
  ORDER BY member.id
  LIMIT p_limit;
END;
$$;
