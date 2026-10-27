CREATE OR REPLACE FUNCTION private.history_restore_lineups()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE restored integer;
BEGIN
  WITH recovered AS (
    INSERT INTO public.weekly_lineups
    SELECT (jsonb_populate_record(NULL::public.weekly_lineups,r.row_data)).*
    FROM private.lineup_history_receipts r
    JOIN public.league_seasons s ON s.id=(r.row_data->>'league_season_id')::uuid
    JOIN public.league_members m ON m.id=(r.row_data->>'member_id')::uuid AND m.league_id=s.league_id
    JOIN public.players p ON p.id=r.player_id
    WHERE NOT EXISTS(SELECT 1 FROM private.retired_score_inputs retired WHERE retired.league_season_id=s.id)
      AND NOT EXISTS(SELECT 1 FROM public.weekly_lineups w WHERE w.id=r.lineup_id)
    ORDER BY r.lineup_id
    ON CONFLICT DO NOTHING
    RETURNING *
  )
  INSERT INTO public.league_events(league_id,member_id,kind,summary,detail)
  SELECT league_id,member_id,'lineup.history_restored','Historical lineup restored',
    jsonb_build_object('lineup_id',id,'player_id',player_id,'game_date',game_date,'row',to_jsonb(recovered))
  FROM recovered;
  GET DIAGNOSTICS restored=ROW_COUNT;
  RAISE LOG 'Historical lineup repair restored % rows',restored;
  RETURN restored;
END;
$$;
