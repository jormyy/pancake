CREATE OR REPLACE FUNCTION private.trade_revaluation_next_change()
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT LEAST(((now() AT TIME ZONE 'America/New_York')::date+1)::timestamp AT TIME ZONE 'America/New_York',
    (SELECT min(fetched_at) FROM public.dynasty_rankings WHERE fetched_at>now()),
    (SELECT min(fetched_at)+interval '90 days 1 microsecond' FROM public.dynasty_rankings WHERE fetched_at>=now()-interval '90 days'),
    (SELECT min(fetched_at) FROM public.fantasypros_projection_rows WHERE fetched_at>now()),
    (SELECT min(fetched_at)+interval '36 hours 1 microsecond' FROM public.fantasypros_projection_rows WHERE fetched_at>=now()-interval '36 hours'),
    (SELECT min(fetched_at)+interval '8 days 1 microsecond' FROM public.fantasypros_projection_rows WHERE fetched_at>=now()-interval '8 days'),
    (SELECT min(fetched_at) FROM public.sleeper_projection_rows WHERE fetched_at>now()),
    (SELECT min(fetched_at)+interval '36 hours 1 microsecond' FROM public.sleeper_projection_rows WHERE fetched_at>=now()-interval '36 hours'),
    (SELECT min(fetched_at) FROM public.player_projections WHERE fetched_at>now()),
    (SELECT min(fetched_at)+interval '8 days 1 microsecond' FROM public.player_projections WHERE fetched_at>=now()-interval '8 days'),
    (SELECT min(game_time) FROM public.nba_games WHERE game_time>now()),
    (SELECT min(started_at) FROM public.nba_games WHERE started_at>now()));
$$;
REVOKE ALL ON FUNCTION private.trade_revaluation_next_change() FROM PUBLIC,anon,authenticated,service_role;
