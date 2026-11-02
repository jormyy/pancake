BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='30s';
CREATE OR REPLACE FUNCTION private.emit_league_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows text; v_scopes text; v_topic text; v_change record;
  v_ignored text[] := ARRAY['updated_at','set_at'];
  official_change boolean:=false;
BEGIN
  IF TG_TABLE_NAME='nba_games' THEN
    v_ignored := v_ignored || ARRAY['live_stats_elapsed_seconds','live_scoreboard_elapsed_seconds'];
  END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM new_rows) THEN RETURN NULL; END IF;
  ELSIF TG_OP='DELETE' THEN
    IF NOT EXISTS(SELECT 1 FROM old_rows) THEN RETURN NULL; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM new_rows n JOIN old_rows o USING(id)
    WHERE (to_jsonb(n)-v_ignored) IS DISTINCT FROM (to_jsonb(o)-v_ignored)) THEN
    RETURN NULL;
  END IF;
  IF TG_OP='INSERT' THEN v_rows := 'SELECT * FROM new_rows';
  ELSIF TG_OP='DELETE' THEN v_rows := 'SELECT * FROM old_rows';
  ELSE
    v_rows := format($rows$SELECT n.* FROM new_rows n JOIN old_rows o USING(id)
      WHERE (to_jsonb(n)-%L::text[]) IS DISTINCT FROM (to_jsonb(o)-%L::text[])
      UNION ALL SELECT o.* FROM old_rows o JOIN new_rows n USING(id)
      WHERE (to_jsonb(n)-%L::text[]) IS DISTINCT FROM (to_jsonb(o)-%L::text[])$rows$,v_ignored,v_ignored,v_ignored,v_ignored);
  END IF;
  IF auth.role()='service_role' AND COALESCE(NULLIF(current_setting('request.headers',true),'')::jsonb,'{}'::jsonb)->>'x-pancake-public-checkpoint'='true' THEN
    IF TG_TABLE_NAME='player_game_stats' THEN
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM (%s) changed JOIN public.nba_games game ON game.id=changed.game_id WHERE game.status=''Final'')',v_rows) INTO official_change;
    ELSIF TG_TABLE_NAME='nba_games' THEN
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM (%s) changed WHERE status=''Final'')',v_rows) INTO official_change;
    ELSIF TG_TABLE_NAME='matchups' THEN
      official_change:=TG_OP<>'UPDATE';
      IF TG_OP='UPDATE' THEN
        SELECT EXISTS(SELECT 1 FROM new_rows n JOIN old_rows o USING(id)
          WHERE n.is_finalized OR o.is_finalized OR EXISTS(SELECT 1 FROM public.player_game_stats stat
            JOIN public.nba_games game ON game.id=stat.game_id AND game.status='Final'
            JOIN public.league_seasons season ON season.id=n.league_season_id AND season.season_year=game.season_year
            JOIN public.season_weeks week ON week.season_year=season.season_year AND week.week_number BETWEEN n.week_number AND COALESCE(n.end_week_number,n.week_number)
            WHERE stat.game_date BETWEEN week.week_start AND week.week_end AND stat.updated_at>=COALESCE((
              SELECT min(state.checkpoint_at) FROM private.live_poll_game_state state
              JOIN public.nba_games active ON active.id=state.game_id
              WHERE active.status='InProgress' AND active.season_year=season.season_year
                AND active.game_date BETWEEN week.week_start AND week.week_end),'-infinity'::timestamptz))) INTO official_change;
      END IF;
    END IF;
    IF official_change THEN PERFORM set_config('pancake.official_broadcast','true',true); END IF;
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'weekly_lineups' THEN
      v_topic := 'lineup';
      v_scopes := $scopes$SELECT league_id,jsonb_build_object('season_id',league_season_id,'member_id',member_id,'date',game_date) AS scope FROM changed$scopes$;
    WHEN 'roster_players' THEN
      v_topic := 'roster';
      v_scopes := $scopes$SELECT league_id,jsonb_build_object('season_id',league_season_id,'member_id',member_id) AS scope FROM changed$scopes$;
    WHEN 'matchups' THEN
      v_topic := 'score';
      v_scopes := $scopes$SELECT league_id,jsonb_build_object('season_id',league_season_id,'week',week_number) AS scope FROM changed$scopes$;
    WHEN 'nba_games' THEN
      v_topic := 'game';
      v_scopes := $scopes$SELECT season.league_id,jsonb_build_object('season_id',season.id,'date',game.game_date) AS scope
        FROM changed game JOIN public.league_seasons season ON season.season_year=game.season_year
        WHERE game.nba_game_id LIKE '002%'$scopes$;
    WHEN 'player_game_stats' THEN
      v_topic := 'stat';
      v_scopes := $scopes$SELECT roster.league_id,jsonb_build_object('season_id',roster.league_season_id,'date',stat.game_date) AS scope
        FROM changed stat JOIN public.nba_games game ON game.id=stat.game_id AND game.nba_game_id LIKE '002%'
        JOIN public.roster_players roster ON roster.player_id=stat.player_id
        JOIN public.league_seasons season ON season.id=roster.league_season_id AND season.season_year=stat.season_year
        UNION SELECT lineup.league_id,jsonb_build_object('season_id',lineup.league_season_id,'date',stat.game_date) AS scope
        FROM changed stat JOIN public.nba_games game ON game.id=stat.game_id AND game.nba_game_id LIKE '002%'
        JOIN public.weekly_lineups lineup ON lineup.player_id=stat.player_id AND lineup.game_date=stat.game_date$scopes$;
    ELSE RAISE EXCEPTION 'Unsupported league change source';
  END CASE;
  FOR v_change IN EXECUTE format($query$
    WITH changed AS (%s),scopes AS (%s),distinct_scopes AS (
      SELECT DISTINCT scopes.league_id,scopes.scope FROM scopes
      JOIN public.leagues league ON league.id=scopes.league_id AND league.deleted_at IS NULL
    ) SELECT league_id,CASE WHEN count(*)<=16 THEN jsonb_agg(scope ORDER BY scope::text) END AS scopes
      FROM distinct_scopes GROUP BY league_id ORDER BY league_id
  $query$,v_rows,v_scopes) LOOP
    IF current_setting('pancake.trade_write',true)='true' THEN
      PERFORM private.queue_trade_publication(v_change.league_id,v_topic,TG_TABLE_NAME);
      CONTINUE;
    END IF;
    INSERT INTO public.league_change_hints AS stored(league_id,topic,revision,scopes)
      VALUES(v_change.league_id,v_topic,1,v_change.scopes)
    ON CONFLICT(league_id,topic) DO UPDATE SET
      revision=stored.revision+(stored.xmin<>pg_current_xact_id()::xid)::integer,
      scopes=CASE WHEN stored.xmin<>pg_current_xact_id()::xid THEN EXCLUDED.scopes
        WHEN stored.scopes IS NULL OR EXCLUDED.scopes IS NULL THEN NULL
        WHEN (SELECT count(DISTINCT scope) FROM jsonb_array_elements(stored.scopes||EXCLUDED.scopes) scope)>16 THEN NULL
        ELSE (SELECT jsonb_agg(scope ORDER BY scope::text) FROM
          (SELECT DISTINCT scope FROM jsonb_array_elements(stored.scopes||EXCLUDED.scopes) scope) merged) END,
      updated_at=clock_timestamp()
    WHERE stored.xmin<>pg_current_xact_id()::xid
      OR stored.scopes IS NOT NULL AND (EXCLUDED.scopes IS NULL OR NOT stored.scopes @> EXCLUDED.scopes);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.broadcast_live_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current_row jsonb:='{}'; previous_row jsonb:='{}'; payload jsonb; target text; targets text[]:=ARRAY[]::text[];
  row_data jsonb; league_id uuid; draft_id uuid; new_data jsonb:='{}'; old_data jsonb:='{}'; headers jsonb;
BEGIN
  IF TG_OP<>'DELETE' THEN current_row:=to_jsonb(NEW); END IF;
  IF TG_OP<>'INSERT' THEN previous_row:=to_jsonb(OLD); END IF;
  headers:=COALESCE(NULLIF(current_setting('request.headers',true),'')::jsonb,'{}'::jsonb);
  IF TG_TABLE_NAME='league_change_hints' AND auth.role()='service_role'
    AND headers->>'x-pancake-public-checkpoint'='true'
    AND current_setting('pancake.official_broadcast',true) IS DISTINCT FROM 'true'
    AND EXISTS(SELECT 1 FROM public.live_poll_leases WHERE lock_key=779001
      AND holder_id::text=headers->>'x-pancake-live-holder' AND expires_at>clock_timestamp())
    AND (current_row->>'topic' IN ('score','stat','game','player_stats') OR current_row->>'topic'='version'
      AND jsonb_array_length(COALESCE(current_row->'details'->0->'scope'->'tables','[]'::jsonb))>0
      AND current_row->'details'->0->'scope'->'tables' <@ '["matchups","matchup_totals","nba_games","player_game_stats"]'::jsonb) THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='league_change_hints' THEN
    new_data:=current_row;
    IF TG_OP='DELETE' THEN old_data:=previous_row; END IF;
  ELSIF TG_TABLE_NAME='roster_players' THEN
    new_data:=jsonb_strip_nulls(jsonb_build_object('member_id',current_row->'member_id'));
    old_data:=jsonb_strip_nulls(jsonb_build_object('member_id',previous_row->'member_id'));
  ELSIF TG_TABLE_NAME='matchup_forecasts' THEN
    new_data:=jsonb_strip_nulls(jsonb_build_object('matchup_id',current_row->'matchup_id'));
    old_data:=jsonb_strip_nulls(jsonb_build_object('matchup_id',previous_row->'matchup_id'));
  END IF;
  payload:=jsonb_build_object('schema','public','table',TG_TABLE_NAME,'eventType',TG_OP,
    'commit_timestamp',clock_timestamp(),'new',new_data,'old',old_data,'errors','[]'::jsonb);
  FOREACH row_data IN ARRAY ARRAY[current_row,previous_row] LOOP
    IF row_data='{}'::jsonb THEN CONTINUE; END IF;
    IF TG_TABLE_NAME='waiver_claims' THEN
      targets:=array_append(targets,'l1:member:'||(row_data->>'member_id'));
      CONTINUE;
    END IF;
    league_id:=NULL; draft_id:=NULL;
    IF TG_TABLE_NAME='leagues' THEN league_id:=(row_data->>'id')::uuid;
    ELSE league_id:=(row_data->>'league_id')::uuid; END IF;
    IF TG_TABLE_NAME='drafts' THEN draft_id:=(row_data->>'id')::uuid;
    ELSIF TG_TABLE_NAME IN ('draft_budgets','nominations','snake_draft_picks') THEN draft_id:=(row_data->>'draft_id')::uuid; END IF;
    IF draft_id IS NOT NULL THEN
      targets:=array_append(targets,'l1:draft:'||draft_id::text);
      IF league_id IS NULL THEN SELECT draft.league_id INTO league_id FROM public.drafts draft WHERE draft.id=draft_id; END IF;
    END IF;
    IF league_id IS NOT NULL THEN targets:=array_append(targets,'l1:league:'||league_id::text); END IF;
    IF TG_TABLE_NAME='league_members' THEN targets:=array_append(targets,'l1:user:'||(row_data->>'user_id')); END IF;
  END LOOP;
  FOR target IN SELECT DISTINCT value FROM unnest(targets) value WHERE value IS NOT NULL ORDER BY value LOOP
    IF TG_TABLE_NAME='league_change_hints' THEN
      row_data:=CASE WHEN TG_OP='DELETE' THEN previous_row ELSE current_row END;
      IF target='l1:league:'||(row_data->>'league_id') THEN row_data:=row_data-'league_id'; END IF;
      INSERT INTO private.live_hint_broadcasts AS pending(transaction_id,topic,changes)
        VALUES(pg_current_xact_id(),target,jsonb_build_array(jsonb_build_object('event',TG_OP,
          'row',row_data)))
      ON CONFLICT(transaction_id,topic) DO UPDATE SET changes=pending.changes||EXCLUDED.changes;
    ELSIF target LIKE 'l1:league:%' THEN
      INSERT INTO private.live_hint_broadcasts AS pending(transaction_id,topic,changes)
        VALUES(pg_current_xact_id(),target,jsonb_build_array(jsonb_build_object('payload',payload)))
      ON CONFLICT(transaction_id,topic) DO UPDATE SET changes=pending.changes||EXCLUDED.changes;
    ELSE
      PERFORM realtime.send(payload,'change',target,true);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

COMMIT;
