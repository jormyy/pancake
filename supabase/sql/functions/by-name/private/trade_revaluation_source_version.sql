CREATE OR REPLACE FUNCTION private.trade_revaluation_source_version(p_season_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH context AS MATERIALIZED (
    SELECT current_season.id,season.league_id,current_season.season_year,league.roster_size,league.scoring_settings,
      league.faab_starting_budget,league.future_pick_years,queued.averages_initialized,
      (SELECT count(*) FROM public.league_members member WHERE member.league_id=league.id) AS teams
    FROM public.league_seasons season JOIN public.leagues league ON league.id=season.league_id AND league.deleted_at IS NULL
    JOIN public.league_seasons current_season ON current_season.league_id=league.id AND current_season.is_current
    LEFT JOIN private.screen_refresh_queue queued ON queued.league_season_id=current_season.id
    WHERE season.id=p_season_id
  ), open_trades AS MATERIALIZED (
    SELECT trade.id FROM public.trades trade JOIN context ON context.league_id=trade.league_id WHERE trade.status IN ('pending','accepted')
  ), assets AS MATERIALIZED (
    SELECT item.* FROM public.trade_items item JOIN open_trades trade ON trade.id=item.trade_id
  )
  SELECT md5(jsonb_build_array('trade-scan-v2',to_jsonb(context),
    (now() AT TIME ZONE 'America/New_York')::date,
    (SELECT jsonb_agg(id ORDER BY id) FROM open_trades),
    (SELECT jsonb_agg(jsonb_build_array(source,scope,revision) ORDER BY source,scope) FROM (
      SELECT source,scope,sum(revision)+CASE WHEN source='public.players' AND scope=''
        THEN GREATEST(COALESCE(NULLIF(current_setting('pancake.trade_player_revision',true),'')::bigint,0)-1,0) ELSE 0 END AS revision
      FROM private.trade_input_revisions WHERE scope IN ('',context.league_id::text,context.id::text)
      GROUP BY source,scope) versions),
    (SELECT jsonb_agg(jsonb_build_array(trade_id,id,from_member_id,to_member_id,player_id,pick_id,faab_amount) ORDER BY trade_id,id) FROM assets),
    (SELECT jsonb_agg(jsonb_build_array(pick.id,pick.season_year,pick.round,pick.current_owner_id,pick.original_owner_id,
      member.team_name,slot.pick_in_round,pick.predicted_trade_value,pick.predicted_value_bands,
      pick.prediction_version,pick.prediction_source_sha256) ORDER BY pick.id)
      FROM public.draft_picks pick JOIN public.league_members member ON member.id=pick.original_owner_id
      LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
      WHERE pick.id IN(SELECT pick_id FROM assets)),
    (SELECT jsonb_agg(jsonb_build_array(member.id,COALESCE(balance.balance,context.faab_starting_budget)) ORDER BY member.id)
      FROM public.league_members member LEFT JOIN public.faab_balances balance
        ON balance.member_id=member.id AND balance.league_season_id=context.id
      WHERE member.league_id=context.league_id AND member.id IN(SELECT from_member_id FROM assets))
  )::text) FROM context WHERE EXISTS(SELECT 1 FROM open_trades);
$$;
REVOKE ALL ON FUNCTION private.trade_revaluation_source_version(uuid) FROM PUBLIC,anon,authenticated,service_role;
