CREATE OR REPLACE FUNCTION private.assert_nba_game_candidate(
  p_provider_id text,p_year int,p_date date,p_home text,p_away text,p_ignore uuid DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_other text;
BEGIN
  SELECT nba_game_id INTO v_other FROM public.nba_games
   WHERE season_year=p_year AND game_date=p_date AND id IS DISTINCT FROM p_ignore
     AND upper(btrim(home_team))=upper(btrim(p_home)) AND upper(btrim(away_team))=upper(btrim(p_away))
     AND nba_game_id IS DISTINCT FROM p_provider_id
     AND private.nba_game_provider(nba_game_id)<>private.nba_game_provider(p_provider_id)
   ORDER BY id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Unresolved game identity: % and %. Verify the provider relationship before importing or scoring.',p_provider_id,v_other
      USING ERRCODE='55000';
  END IF;
END;
$$;
