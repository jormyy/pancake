CREATE OR REPLACE FUNCTION private.retain_player_game_stats(p_now timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='100ms' SET statement_timeout='3s' AS $$
DECLARE season integer:=extract(year FROM p_now AT TIME ZONE 'America/New_York')::integer
  +(extract(month FROM p_now AT TIME ZONE 'America/New_York')>=7)::integer;
BEGIN
  PERFORM private.ensure_player_stats_partition(season);
  RETURN jsonb_build_object('public.player_game_stats',0);
END;
$$;
