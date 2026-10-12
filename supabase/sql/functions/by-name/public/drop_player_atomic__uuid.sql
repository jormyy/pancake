CREATE OR REPLACE FUNCTION public.drop_player_atomic(p_roster_player_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.drop_player_atomic(p_roster_player_id, NULL::uuid);
$function$;
