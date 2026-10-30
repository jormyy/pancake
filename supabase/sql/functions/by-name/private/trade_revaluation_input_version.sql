-- Canonical SQL source for private.trade_revaluation_input_version.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.trade_revaluation_input_version(p_trade_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' SET plan_cache_mode = force_generic_plan AS $$
BEGIN
  RETURN (
  WITH context AS MATERIALIZED (
    SELECT trade.id,league.id AS league_id,season.id AS season_id,season.season_year,
      league.roster_size,league.scoring_settings,league.faab_starting_budget,league.future_pick_years,
      (SELECT count(*) FROM public.league_members member WHERE member.league_id=league.id) AS teams,
      queued.averages_initialized
    FROM public.trades trade JOIN public.leagues league ON league.id=trade.league_id AND league.deleted_at IS NULL
    JOIN public.league_seasons season ON season.league_id=league.id AND season.is_current
    LEFT JOIN private.screen_refresh_queue queued ON queued.league_season_id=season.id
    WHERE trade.id=p_trade_id AND trade.status IN ('pending','accepted')
  ), assets AS MATERIALIZED (
    SELECT item.* FROM public.trade_items item WHERE item.trade_id=p_trade_id
  )
  SELECT md5(jsonb_build_array('trade-inputs-v2',to_jsonb(context),
    (SELECT jsonb_agg(jsonb_build_array(source,scope,revision) ORDER BY source,scope) FROM (
      SELECT source,scope,sum(revision)+CASE WHEN source='public.players' AND scope=''
        THEN GREATEST(COALESCE(NULLIF(current_setting('pancake.trade_player_revision',true),'')::bigint,0)-1,0) ELSE 0 END AS revision
      FROM private.trade_input_revisions
      WHERE scope IN ('',context.league_id::text,context.season_id::text) GROUP BY source,scope) versions),
    (SELECT jsonb_agg(jsonb_build_array(from_member_id,to_member_id,player_id,pick_id,faab_amount) ORDER BY id) FROM assets),
    (SELECT jsonb_agg(jsonb_build_array(pick.id,pick.season_year,pick.round,pick.current_owner_id,pick.original_owner_id,
      member.team_name,slot.pick_in_round,pick.predicted_trade_value,pick.predicted_value_bands,
      pick.prediction_version,pick.prediction_source_sha256) ORDER BY pick.id)
      FROM public.draft_picks pick JOIN public.league_members member ON member.id=pick.original_owner_id
      LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
      WHERE pick.id IN(SELECT pick_id FROM assets)),
    (SELECT jsonb_agg(jsonb_build_array(member.id,COALESCE(balance.balance,context.faab_starting_budget)) ORDER BY member.id)
      FROM public.league_members member LEFT JOIN public.faab_balances balance
        ON balance.member_id=member.id AND balance.league_season_id=context.season_id
      WHERE member.league_id=context.league_id AND member.id IN(SELECT from_member_id FROM assets)),
    (now() AT TIME ZONE 'America/New_York')::date,
    (SELECT max(fetched_at) FROM public.dynasty_rankings WHERE fetched_at<=now()),
    (SELECT max(fetched_at) FROM public.dynasty_rankings WHERE fetched_at<now()-interval '90 days'),
    (SELECT max(fetched_at) FROM public.fantasypros_projection_rows WHERE fetched_at<=now()),
    (SELECT max(fetched_at) FROM public.fantasypros_projection_rows WHERE fetched_at<now()-interval '36 hours'),
    (SELECT max(fetched_at) FROM public.fantasypros_projection_rows WHERE fetched_at<now()-interval '8 days'),
    (SELECT max(fetched_at) FROM public.sleeper_projection_rows WHERE fetched_at<=now()),
    (SELECT max(fetched_at) FROM public.sleeper_projection_rows WHERE fetched_at<now()-interval '36 hours'),
    (SELECT max(fetched_at) FROM public.player_projections WHERE fetched_at<=now()),
    (SELECT max(fetched_at) FROM public.player_projections WHERE fetched_at<now()-interval '8 days'),
    (SELECT max(game_time) FROM public.nba_games WHERE game_time<=now()),
    (SELECT max(started_at) FROM public.nba_games WHERE started_at<=now())
  )::text) FROM context);
END;
$$;
