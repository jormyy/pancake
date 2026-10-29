CREATE OR REPLACE FUNCTION private.track_trade_input_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed boolean; scope_query text; selected_scope text; columns text:=TG_ARGV[0]; local_revision text;
BEGIN
  IF TG_LEVEL='ROW' THEN
    IF TG_TABLE_NAME='players' THEN
      local_revision:=NULLIF(current_setting('pancake.trade_player_revision',true),'');
      PERFORM set_config('pancake.trade_player_revision',(COALESCE(local_revision::bigint,0)+1)::text,true);
      IF local_revision IS NOT NULL THEN RETURN NULL; END IF;
    END IF;
    INSERT INTO private.trade_input_revisions AS current(source,scope,writer,revision)
      VALUES(TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,'',pg_backend_pid(),1)
      ON CONFLICT(source,scope,writer) DO UPDATE SET revision=current.revision+1;
    RETURN NULL;
  END IF;
  IF TG_TABLE_SCHEMA='analytics' AND pg_trigger_depth()>1 THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' THEN
    changed:=false;
    IF TG_TABLE_NAME IN ('player_projections','fantasypros_projection_rows','sleeper_projection_rows') THEN
      SELECT (SELECT max(fetched_at) FROM trade_new) IS DISTINCT FROM (SELECT max(fetched_at) FROM trade_old) INTO changed;
    END IF;
    IF NOT changed THEN
      IF TG_TABLE_NAME='players' THEN
        SELECT EXISTS(SELECT id,display_name,first_name,last_name,nba_team,position,eligible_positions,injury_status,years_exp,headshot_url,nba_id FROM trade_new EXCEPT SELECT id,display_name,first_name,last_name,nba_team,position,eligible_positions,injury_status,years_exp,headshot_url,nba_id FROM trade_old)
          OR EXISTS(SELECT id,display_name,first_name,last_name,nba_team,position,eligible_positions,injury_status,years_exp,headshot_url,nba_id FROM trade_old EXCEPT SELECT id,display_name,first_name,last_name,nba_team,position,eligible_positions,injury_status,years_exp,headshot_url,nba_id FROM trade_new) INTO changed;
      ELSIF TG_TABLE_NAME='player_game_stats' THEN
        SELECT EXISTS(SELECT id,game_id,player_id,season_year,minutes_played,points,rebounds,assists,steals,blocks,turnovers,three_pointers_made,field_goals_made,field_goals_attempted,free_throws_made,free_throws_attempted,double_double,triple_double,did_not_play FROM trade_new EXCEPT SELECT id,game_id,player_id,season_year,minutes_played,points,rebounds,assists,steals,blocks,turnovers,three_pointers_made,field_goals_made,field_goals_attempted,free_throws_made,free_throws_attempted,double_double,triple_double,did_not_play FROM trade_old) INTO changed;
      ELSIF TG_TABLE_NAME='player_projections' THEN
        SELECT EXISTS(SELECT id,player_id,season_year,week_number,projected_stat_points,projected_rebounds,projected_assists,projected_steals,projected_blocks,projected_three_pointers_made,projected_turnovers,projected_field_goals_made,projected_field_goals_attempted,projected_free_throws_made,projected_free_throws_attempted,projected_double_doubles,projected_triple_doubles,fetched_at FROM trade_new EXCEPT SELECT id,player_id,season_year,week_number,projected_stat_points,projected_rebounds,projected_assists,projected_steals,projected_blocks,projected_three_pointers_made,projected_turnovers,projected_field_goals_made,projected_field_goals_attempted,projected_free_throws_made,projected_free_throws_attempted,projected_double_doubles,projected_triple_doubles,fetched_at FROM trade_old) INTO changed;
      ELSE
        EXECUTE format('SELECT EXISTS(SELECT %s FROM trade_new EXCEPT SELECT %s FROM trade_old) OR EXISTS(SELECT %s FROM trade_old EXCEPT SELECT %s FROM trade_new)',
          columns,columns,columns,columns) INTO changed;
      END IF;
    END IF;
    IF NOT changed THEN RETURN NULL; END IF;
  ELSIF TG_OP<>'TRUNCATE' THEN
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I)',CASE WHEN TG_OP='DELETE' THEN 'trade_old' ELSE 'trade_new' END) INTO changed;
    IF NOT changed THEN RETURN NULL; END IF;
  END IF;
  IF TG_NARGS<2 OR TG_OP='TRUNCATE' THEN
    INSERT INTO private.trade_input_revisions AS current(source,scope,writer,revision)
      VALUES(TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,'',pg_backend_pid(),1)
      ON CONFLICT(source,scope,writer) DO UPDATE SET revision=current.revision+1;
    RETURN NULL;
  ELSE
    scope_query:=CASE WHEN TG_OP<>'INSERT' THEN format('SELECT %I::text FROM trade_old',TG_ARGV[1]) ELSE '' END
      ||CASE WHEN TG_OP='UPDATE' THEN ' UNION ' ELSE '' END
      ||CASE WHEN TG_OP<>'DELETE' THEN format('SELECT %I::text FROM trade_new',TG_ARGV[1]) ELSE '' END;
  END IF;
  FOR selected_scope IN EXECUTE 'SELECT DISTINCT scope FROM ('||scope_query||') AS affected(scope) ORDER BY scope' LOOP
    INSERT INTO private.trade_input_revisions AS current(source,scope,writer,revision)
      VALUES(TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,selected_scope,pg_backend_pid(),1)
      ON CONFLICT(source,scope,writer) DO UPDATE SET revision=current.revision+1;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.track_trade_input_revision() FROM PUBLIC,anon,authenticated,service_role;
