CREATE OR REPLACE FUNCTION public.publish_trade_values(p_rows jsonb,p_picks jsonb,p_source_body text,p_fetched_at timestamptz,p_mode text,p_request_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_state private.trade_value_sync_state%ROWTYPE; v_matched integer; v_duplicates integer;
BEGIN
  SELECT * INTO v_state FROM private.trade_value_sync_state WHERE id FOR UPDATE;
  IF p_mode IS NULL OR p_mode NOT IN ('live','json','csv')
    OR p_source_body IS NULL OR length(p_source_body) NOT BETWEEN 1 AND 2000000 OR p_fetched_at IS NULL OR p_fetched_at>clock_timestamp()+interval '5 minutes'
    OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_typeof(p_picks) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_rows)<>450 OR jsonb_array_length(p_picks)<>18 THEN
    RAISE EXCEPTION 'Trade value snapshot must contain 450 players and 18 picks.' USING ERRCODE='22023';
  END IF;
  IF p_mode='live' AND (p_request_id IS NULL OR p_request_id IS DISTINCT FROM v_state.request_id) THEN
    RAISE EXCEPTION 'Trade value fetch claim has expired.' USING ERRCODE='40001';
  END IF;
  IF v_state.fetched_at>=p_fetched_at THEN RETURN jsonb_build_object('stale',true); END IF;
  DROP TABLE IF EXISTS pg_temp.trade_value_players;
  CREATE TEMP TABLE trade_value_players ON COMMIT DROP AS
    SELECT * FROM jsonb_to_recordset(p_rows) AS row(source_id text,name text,team text,positions text[],rank integer,
      value numeric,age numeric,player_id uuid,reason text,candidate_ids uuid[]);
  DROP TABLE IF EXISTS pg_temp.trade_value_picks;
  CREATE TEMP TABLE trade_value_picks ON COMMIT DROP AS
    SELECT * FROM jsonb_to_recordset(p_picks) AS row(year integer,round integer,tier text,value numeric);
  IF EXISTS(SELECT 1 FROM pg_temp.trade_value_players WHERE source_id IS NULL OR btrim(name)='' OR name IS NULL
      OR rank IS NULL OR rank NOT BETWEEN 1 AND 468 OR value IS NULL OR value NOT BETWEEN 0 AND 1000
      OR cardinality(positions)=0 OR positions IS NULL OR team IS NULL)
    OR EXISTS(SELECT 1 FROM pg_temp.trade_value_picks WHERE year IS NULL OR round IS NULL OR round NOT IN(1,2)
      OR tier IS NULL OR tier NOT IN('early','mid','late') OR value IS NULL OR value NOT BETWEEN 0 AND 1000)
    OR (SELECT count(DISTINCT (year,round,tier)) FROM pg_temp.trade_value_picks)<>18
    OR (SELECT count(DISTINCT year) FROM pg_temp.trade_value_picks)<>3
    OR (SELECT max(year)-min(year) FROM pg_temp.trade_value_picks)<>2
    OR (SELECT count(DISTINCT source_id) FROM pg_temp.trade_value_players)<>450
    OR (SELECT count(DISTINCT rank) FROM pg_temp.trade_value_players)<>450 THEN
    RAISE EXCEPTION 'Trade value snapshot violates the source contract.' USING ERRCODE='22023';
  END IF;
  UPDATE pg_temp.trade_value_players stage SET player_id=review.resolved_player_id
    FROM public.trade_value_reviews review WHERE review.source_id=stage.source_id AND review.resolved_player_id IS NOT NULL;
  SELECT count(player_id)-count(DISTINCT player_id) INTO v_duplicates FROM pg_temp.trade_value_players;
  IF v_duplicates<>0 THEN RAISE EXCEPTION 'A player cannot receive two source values.' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM pg_temp.trade_value_players row LEFT JOIN public.players player ON player.id=row.player_id
    WHERE row.player_id IS NOT NULL AND player.id IS NULL) THEN
    RAISE EXCEPTION 'A matched player no longer exists.' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.dynasty_rankings(source,source_rank,source_player_id,source_player_name,source_team,source_positions,
    player_id,age,scoring_format,source_url,source_metadata,trade_value,fetched_at)
  SELECT 'onenumberhoops.com',rank,source_id,name,team,positions,player_id,age,'overall',
    'https://www.onenumberhoops.com/rankings',jsonb_build_object('importMode',p_mode,'scaleDivisor',10),value,p_fetched_at
  FROM pg_temp.trade_value_players
  ON CONFLICT(source,source_rank) DO UPDATE SET source_player_id=EXCLUDED.source_player_id,
    source_player_name=EXCLUDED.source_player_name,source_team=EXCLUDED.source_team,source_positions=EXCLUDED.source_positions,
    player_id=EXCLUDED.player_id,age=EXCLUDED.age,source_metadata=EXCLUDED.source_metadata,
    trade_value=EXCLUDED.trade_value,fetched_at=EXCLUDED.fetched_at,updated_at=clock_timestamp();
  DELETE FROM public.dynasty_rankings WHERE source='onenumberhoops.com'
    AND source_rank NOT IN(SELECT rank FROM pg_temp.trade_value_players);
  UPDATE public.players player SET dynasty_rank=row.rank,dynasty_rank_source='onenumberhoops.com',dynasty_rank_fetched_at=p_fetched_at
    FROM pg_temp.trade_value_players row WHERE player.id=row.player_id;
  UPDATE public.players SET dynasty_rank=NULL,dynasty_rank_source=NULL,dynasty_rank_fetched_at=NULL
    WHERE dynasty_rank_source='onenumberhoops.com' AND id NOT IN(SELECT player_id FROM pg_temp.trade_value_players WHERE player_id IS NOT NULL);
  DELETE FROM public.trade_value_reviews WHERE resolved_player_id IS NULL
    AND source_id NOT IN(SELECT source_id FROM pg_temp.trade_value_players WHERE player_id IS NULL);
  INSERT INTO public.trade_value_reviews(source_id,source_name,source_team,source_positions,trade_value,reason,candidate_ids,fetched_at)
  SELECT source_id,name,team,positions,value,reason,COALESCE(candidate_ids,'{}'),p_fetched_at
    FROM pg_temp.trade_value_players WHERE player_id IS NULL
  ON CONFLICT(source_id) DO UPDATE SET source_name=EXCLUDED.source_name,source_team=EXCLUDED.source_team,
    source_positions=EXCLUDED.source_positions,trade_value=EXCLUDED.trade_value,reason=EXCLUDED.reason,
    candidate_ids=EXCLUDED.candidate_ids,fetched_at=EXCLUDED.fetched_at;
  DELETE FROM public.dynasty_pick_values WHERE source='onenumberhoops.com';
  INSERT INTO public.dynasty_pick_values(draft_year,round,tier,trade_value,derived,fetched_at)
    SELECT year,round,tier,value,false,p_fetched_at FROM pg_temp.trade_value_picks
    UNION ALL SELECT year,3,tier,round(value*0.4,2),true,p_fetched_at FROM pg_temp.trade_value_picks WHERE round=2;
  SELECT count(*) INTO v_matched FROM pg_temp.trade_value_players WHERE player_id IS NOT NULL;
  UPDATE private.trade_value_sync_state SET fetched_at=p_fetched_at,source_body=p_source_body,mode=p_mode,
    matched=v_matched,content_sha256=encode(extensions.digest(p_source_body,'sha256'),'hex') WHERE id;
  INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details)
    SELECT id,'resources',1,NULL,NULL FROM public.leagues WHERE deleted_at IS NULL
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,scopes=NULL,details=NULL,updated_at=clock_timestamp();
  RETURN jsonb_build_object('players',450,'matched',v_matched,'unmatched',450-v_matched,'picks',18,'derivedPicks',9);
END;
$$;
REVOKE ALL ON FUNCTION public.publish_trade_values(jsonb,jsonb,text,timestamptz,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_trade_values(jsonb,jsonb,text,timestamptz,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_trade_value_review(p_source_id text,p_player_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.league_members member JOIN public.leagues league ON league.id=member.league_id
    WHERE member.user_id=auth.uid() AND league.deleted_at IS NULL AND member.role IN('commissioner','co_commissioner'))
    AND COALESCE(auth.jwt()->'app_metadata'->>'role','')<>'admin' THEN
    RAISE EXCEPTION 'Only commissioners and admins can resolve value matches.' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM private.trade_value_sync_state WHERE id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.players WHERE id=p_player_id) THEN RAISE EXCEPTION 'Player not found.' USING ERRCODE='22023'; END IF;
  IF EXISTS(SELECT 1 FROM public.dynasty_rankings WHERE source='onenumberhoops.com' AND player_id=p_player_id AND source_player_id<>p_source_id) THEN
    RAISE EXCEPTION 'Player already has a source value.' USING ERRCODE='22023';
  END IF;
  UPDATE public.trade_value_reviews SET resolved_player_id=p_player_id,resolved_by=auth.uid(),resolved_at=clock_timestamp()
    WHERE source_id=p_source_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Review not found.' USING ERRCODE='22023'; END IF;
  UPDATE public.dynasty_rankings SET player_id=p_player_id,updated_at=clock_timestamp()
    WHERE source='onenumberhoops.com' AND source_player_id=p_source_id;
  UPDATE public.players player SET dynasty_rank=ranking.source_rank,dynasty_rank_source=ranking.source,
    dynasty_rank_fetched_at=ranking.fetched_at FROM public.dynasty_rankings ranking
    WHERE player.id=p_player_id AND ranking.source='onenumberhoops.com' AND ranking.source_player_id=p_source_id;
  INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes,details)
    SELECT id,'resources',1,NULL,NULL FROM public.leagues WHERE deleted_at IS NULL
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=stored.revision+1,scopes=NULL,details=NULL,updated_at=clock_timestamp();
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_trade_value_review(text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.resolve_trade_value_review(text,uuid) TO authenticated;
