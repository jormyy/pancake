CREATE OR REPLACE FUNCTION public.drop_player_atomic(p_roster_player_id uuid, p_expected_league_season_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.drop_player_atomic(p_roster_player_id, p_expected_league_season_id, NULL::uuid);
$function$;
