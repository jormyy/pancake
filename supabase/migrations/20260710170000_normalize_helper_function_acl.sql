-- Make helper and trigger privileges deterministic across fresh and incremental databases.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trade_participants
  TO service_role;

REVOKE ALL ON FUNCTION public.compute_fantasy_points(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.compute_fantasy_points(uuid, uuid)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.current_season_year_et(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.current_season_year_et(timestamptz)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.delete_league_atomic(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_league_atomic(uuid)
  TO authenticated;

REVOKE ALL ON FUNCTION public.is_regular_season_game_id(text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_regular_season_game_id(text)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.lineup_slot_allowed_positions(public.roster_slot_type)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lineup_slot_allowed_positions(public.roster_slot_type)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.projection_stat_fantasy_points(
  numeric, numeric, numeric, numeric, numeric, numeric, numeric,
  numeric, numeric, numeric, numeric, numeric, numeric, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.projection_stat_fantasy_points(
  numeric, numeric, numeric, numeric, numeric, numeric, numeric,
  numeric, numeric, numeric, numeric, numeric, numeric, jsonb
) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.assert_current_season_for_pending_waiver_claim()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.assert_current_season_for_uncleared_waiver_log()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.leagues_seed_fantasy_avgs()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prevent_playoff_start_week_change_after_bracket()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prevent_season_deactivation_with_pending_waivers()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prevent_trade_acceptance_after_deadline()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seed_default_lineup_slots()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.seed_default_scoring_settings()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_bid_league_id()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_pgs_game_date()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_updated_at()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_veto_window()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_waiver_clears_at()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_weekly_lineup_week_number_from_date()
  FROM PUBLIC, anon, authenticated, service_role;
