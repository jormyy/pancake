CREATE OR REPLACE FUNCTION public.get_trade_estimate_reanalysis_inputs(p_trade_id uuid,p_run text DEFAULT 'onenumber-trade-v1')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  trade public.trades%ROWTYPE; league public.leagues%ROWTYPE; season public.league_seasons%ROWTYPE;
  terms jsonb; player_ids uuid[]; replacement_ids uuid[]; players jsonb; replacements jsonb; picks jsonb;
  actor uuid; teams integer; floor_value numeric; inputs jsonb;
  previous_user text:=current_setting('request.jwt.claim.sub',true);
BEGIN
  SELECT * INTO STRICT trade FROM public.trades WHERE id=p_trade_id;
  IF EXISTS(SELECT 1 FROM public.trade_estimate_history WHERE trade_id=p_trade_id AND formula_version=p_run) THEN RETURN NULL; END IF;
  SELECT * INTO STRICT league FROM public.leagues WHERE id=trade.league_id;
  SELECT * INTO season FROM public.league_seasons WHERE league_id=league.id
    ORDER BY is_current DESC,(id=trade.league_season_id) DESC,season_year DESC LIMIT 1;
  SELECT user_id INTO actor FROM public.league_members WHERE id=trade.proposer_member_id;
  SELECT count(*) INTO teams FROM public.league_members WHERE league_id=league.id;
  SELECT private.canonical_trade_estimate_terms(COALESCE(jsonb_agg(jsonb_build_object(
    'fromMemberId',i.from_member_id,'toMemberId',i.to_member_id,'playerId',i.player_id,'pickId',i.pick_id,'faabAmount',i.faab_amount)),'[]'::jsonb))
    INTO terms FROM public.trade_items i WHERE i.trade_id=trade.id;
  SELECT COALESCE(array_agg((item->>'playerId')::uuid),'{}') INTO player_ids
    FROM jsonb_array_elements(terms) item WHERE item->>'playerId' IS NOT NULL;
  SELECT COALESCE(array_agg(candidate.player_id),'{}') INTO replacement_ids FROM (
    SELECT average.player_id FROM public.v_player_avg_fantasy_points average
    JOIN public.players player ON player.id=average.player_id AND player.nba_team IS NOT NULL
    WHERE average.league_id=league.id AND average.season_year=season.season_year
      AND NOT EXISTS(SELECT 1 FROM public.roster_players r WHERE r.league_id=league.id AND r.league_season_id=season.id AND r.player_id=average.player_id)
    ORDER BY average.avg_fantasy_points DESC,average.player_id LIMIT 5
  ) candidate;
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  players:=private.trade_value_player_inputs(league.id,trade.proposer_member_id,season.season_year,player_ids,100);
  replacements:=private.trade_value_player_inputs(league.id,trade.proposer_member_id,season.season_year,replacement_ids,5);
  SELECT LEAST(500,COALESCE(avg(r.trade_value),GREATEST(50,180.0*200/GREATEST(1,teams*league.roster_size)))) INTO floor_value
    FROM public.dynasty_rankings r WHERE r.source='onenumberhoops.com' AND r.player_id=ANY(replacement_ids);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',pick.id,'seasonYear',pick.season_year,'round',pick.round,
    'ownerId',pick.current_owner_id,'originalOwnerId',pick.original_owner_id,'originalTeamName',member.team_name,'slot',slot.pick_in_round,
    'valueBands',COALESCE((SELECT jsonb_object_agg(v.tier,CASE WHEN v.tier='mid' AND slot.pick_in_round IS NULL AND pick.predicted_trade_value IS NOT NULL THEN pick.predicted_trade_value WHEN v.round=3 THEN GREATEST(v.trade_value,floor_value) ELSE v.trade_value END)
      FROM public.dynasty_pick_values v WHERE v.draft_year=pick.season_year-1 AND v.round=pick.round),CASE WHEN slot.pick_in_round IS NULL AND pick.predicted_trade_value IS NOT NULL THEN jsonb_set(pick.predicted_value_bands,'{mid}',to_jsonb(pick.predicted_trade_value)) ELSE pick.predicted_value_bands END),
    'valueFetchedAt',(SELECT max(v.fetched_at) FROM public.dynasty_pick_values v WHERE v.draft_year=pick.season_year-1 AND v.round=pick.round)) ORDER BY pick.id),'[]'::jsonb)
    INTO picks FROM public.draft_picks pick JOIN public.league_members member ON member.id=pick.original_owner_id
    LEFT JOIN public.snake_draft_picks slot ON slot.draft_pick_id=pick.id
    WHERE pick.id IN(SELECT (item->>'pickId')::uuid FROM jsonb_array_elements(terms) item WHERE item->>'pickId' IS NOT NULL);
  PERFORM set_config('request.jwt.claim.sub',COALESCE(previous_user,''),true);
  inputs:=jsonb_build_object('leagueId',league.id,'seasonId',season.id,'seasonYear',season.season_year,'teams',teams,
    'rosterSize',league.roster_size,'scoringSettings',league.scoring_settings,'faabBudget',league.faab_starting_budget,
    'terms',terms,'players',players,'replacementPlayers',replacements,'picks',picks,'revaluationTradeId',trade.id);
  RETURN inputs||jsonb_build_object('inputVersion',md5(inputs::text),'observedAt',now());
END;
$$;
