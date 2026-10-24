CREATE OR REPLACE FUNCTION private.regular_season_matchup_payload(p_league_id uuid, p_season_id uuid, p_weeks int)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_members uuid[];
  v_count int;
  v_round int;
  v_week int;
  v_pair int;
  v_home uuid;
  v_away uuid;
  v_played int := 0;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  SELECT array_agg(id ORDER BY joined_at, id) INTO v_members FROM public.league_members WHERE league_id = p_league_id;
  v_count := COALESCE(cardinality(v_members), 0);
  IF v_count < 2 OR p_weeks < 1 THEN RETURN v_rows; END IF;
  IF v_count % 2 = 1 THEN
    v_members := array_append(v_members, NULL::uuid);
    v_count := v_count + 1;
  END IF;
  FOR v_week IN 1..p_weeks LOOP
    IF EXISTS (SELECT 1 FROM public.league_seasons WHERE id=p_season_id AND v_week=ANY(skipped_weeks)) THEN CONTINUE; END IF;
    v_round := v_played % (v_count - 1);
    v_played := v_played + 1;
    FOR v_pair IN 0..(v_count / 2 - 1) LOOP
      v_home := CASE WHEN v_pair = 0 THEN v_members[1] ELSE v_members[2 + (v_pair - 1 + v_round) % (v_count - 1)] END;
      v_away := v_members[2 + (v_count - 2 - v_pair + v_round) % (v_count - 1)];
      IF v_home IS NOT NULL AND v_away IS NOT NULL THEN
        v_rows := v_rows || jsonb_build_array(jsonb_build_object(
          'league_id', p_league_id, 'league_season_id', p_season_id,
          'week_number', v_week, 'matchup_type', 'regular_season',
          'home_member_id', v_home, 'away_member_id', v_away));
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_rows;
END;
$$;


CREATE OR REPLACE FUNCTION public.invoke_dynasty_ranking_views_at_et_time(
  p_hour int,
  p_minute int DEFAULT 0,
  p_now timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamp := timezone('America/New_York', p_now);
BEGIN
  IF EXTRACT(ISODOW FROM v_now)::int = 1 AND v_now::time < make_time(p_hour, p_minute, 0) THEN
    RETURN;
  END IF;
  IF NOT private.claim_cron_dispatch('et-time:sync-rankings', to_char(v_now, 'IYYY-IW')) THEN
    RETURN;
  END IF;
  PERFORM private.invoke_claimed_edge_function('et-time:sync-rankings', 'sync-rankings', '{"view":"POINT_3"}'::jsonb);
  PERFORM private.invoke_claimed_edge_function('et-time:sync-rankings', 'sync-rankings', '{"view":"ROOKIE"}'::jsonb);
  PERFORM private.invoke_claimed_edge_function('et-time:sync-rankings', 'sync-rankings', '{"view":"POINT_5"}'::jsonb);
END;
$$;
