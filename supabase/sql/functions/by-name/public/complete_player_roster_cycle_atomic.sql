-- Canonical SQL source for public.complete_player_roster_cycle_atomic.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.complete_player_roster_cycle_atomic(p_espn_records jsonb,p_nba_records jsonb,p_started_at timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_records jsonb; v_source text; v_ids uuid[]:='{}'; v_released uuid[]; v_previous timestamptz; v_teams integer;
BEGIN
  IF p_started_at IS NULL OR p_started_at>clock_timestamp()+interval '5 minutes' THEN
    RAISE EXCEPTION 'Invalid roster cycle time.' USING ERRCODE='22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(1347174745,1);
  SELECT started_at INTO v_previous FROM private.player_roster_cycle_state WHERE singleton FOR UPDATE;
  IF v_previous>=p_started_at THEN RETURN jsonb_build_object('released','[]'::jsonb,'held',0,'stale',true); END IF;
  FOREACH v_source IN ARRAY ARRAY['espn','nba'] LOOP
    v_records:=CASE WHEN v_source='espn' THEN p_espn_records ELSE p_nba_records END;
    IF jsonb_typeof(v_records) IS DISTINCT FROM 'array' OR jsonb_array_length(v_records) NOT BETWEEN 350 AND 1000 THEN
      RAISE EXCEPTION 'Complete ESPN and NBA rosters are required.' USING ERRCODE='22023';
    END IF;
    IF EXISTS(SELECT FROM jsonb_array_elements(v_records) r WHERE nullif(r->>'provider_id','') IS NULL
      OR private.player_identity_team(r->>'nba_team') IS NULL
      OR private.player_identity_team(r->>'nba_team') NOT IN
        ('ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GSW','HOU','IND','LAC','LAL','MEM','MIA','MIL','MIN','NOP','NYK','OKC','ORL','PHI','PHX','POR','SAC','SAS','TOR','UTA','WAS'))
      OR EXISTS(SELECT FROM jsonb_array_elements(v_records) r GROUP BY r->>'provider_id' HAVING count(*)>1) THEN
      RAISE EXCEPTION 'Invalid current roster identities.' USING ERRCODE='22023';
    END IF;
    SELECT count(DISTINCT private.player_identity_team(r->>'nba_team')) INTO v_teams FROM jsonb_array_elements(v_records) r;
    IF v_teams<>30 OR EXISTS(SELECT FROM jsonb_array_elements(v_records) r WHERE NOT EXISTS(
      SELECT FROM public.players p WHERE CASE v_source WHEN 'espn' THEN p.espn_id ELSE p.nba_id END=r->>'provider_id')) THEN
      RAISE EXCEPTION 'Every current roster player must resolve before completing the cycle.' USING ERRCODE='22023';
    END IF;
  END LOOP;
  DELETE FROM private.player_roster_presence WHERE source IN ('espn','nba');
  FOREACH v_source IN ARRAY ARRAY['espn','nba'] LOOP
    v_records:=CASE WHEN v_source='espn' THEN p_espn_records ELSE p_nba_records END;
    INSERT INTO private.player_roster_presence(provider_id,source,nba_team,observed_at)
      SELECT r->>'provider_id',v_source,private.player_identity_team(r->>'nba_team'),p_started_at
      FROM jsonb_array_elements(v_records) r JOIN public.players p
        ON CASE v_source WHEN 'espn' THEN p.espn_id ELSE p.nba_id END=r->>'provider_id';
  END LOOP;
  SELECT array_agg(DISTINCT p.id) INTO v_ids FROM private.player_roster_presence r JOIN public.players p
    ON CASE r.source WHEN 'espn' THEN p.espn_id ELSE p.nba_id END=r.provider_id;
  DELETE FROM private.player_roster_absences WHERE player_id=ANY(v_ids);
  INSERT INTO private.player_roster_absences(player_id,first_absent_at,last_absent_at)
    SELECT p.id,p_started_at,p_started_at FROM public.players p
      WHERE p.nba_team IS NOT NULL AND NOT p.id=ANY(v_ids)
    ON CONFLICT(player_id) DO UPDATE SET first_absent_at=CASE
      WHEN p_started_at-player_roster_absences.last_absent_at>interval '36 hours'
        OR EXISTS(SELECT FROM private.player_espn_listings l WHERE l.player_id=excluded.player_id AND l.listed_at>player_roster_absences.first_absent_at)
        OR EXISTS(SELECT FROM private.player_game_memberships m JOIN public.nba_games g ON g.id=m.game_id
          WHERE m.player_id=excluded.player_id AND coalesce(g.game_time,g.started_at)>player_roster_absences.first_absent_at)
      THEN p_started_at ELSE player_roster_absences.first_absent_at END,last_absent_at=p_started_at;
  WITH released AS (
    UPDATE public.players p SET nba_team=NULL,updated_at=clock_timestamp()
      FROM private.player_roster_absences a WHERE a.player_id=p.id
        AND a.first_absent_at<=p_started_at-interval '24 hours' AND a.last_absent_at=p_started_at
        AND NOT p.id=ANY(v_ids) AND p.nba_team IS NOT NULL RETURNING p.id
  ) SELECT coalesce(array_agg(id),'{}') INTO v_released FROM released;
  DELETE FROM private.player_roster_absences WHERE player_id=ANY(v_released);
  INSERT INTO private.player_roster_cycle_state(singleton,started_at) VALUES(true,p_started_at)
    ON CONFLICT(singleton) DO UPDATE SET started_at=excluded.started_at;
  RETURN jsonb_build_object('released',to_jsonb(v_released),'held',(SELECT count(*) FROM private.player_roster_absences),'stale',false);
END;
$$;
