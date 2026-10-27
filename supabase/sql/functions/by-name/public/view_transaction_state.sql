CREATE OR REPLACE FUNCTION public.view_transaction_state(p_league_id uuid, p_member_id uuid, p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.view_context(p_league_id, p_member_id, p_params);
  SELECT jsonb_build_object('leagueSeasonId', state.league_season_id, 'weekNumber', state.week_number,
    'weeklyAddLimit', state.weekly_add_limit, 'weeklyAddCount', state.weekly_add_count, 'waiverMode', state.waiver_mode,
    'faabStartingBudget', state.faab_starting_budget, 'faabBalance', state.faab_balance, 'addLimitResetsAt', state.add_limit_resets_at,
    'addLimitMessage', state.add_limit_message, 'addLimitResetsLabel', state.add_limit_resets_label) INTO result
    FROM public.get_member_transaction_state(p_member_id, p_league_id) state;
  RETURN result;
END;
$$;
