SET lock_timeout = '5s';
SET statement_timeout = '2min';

CREATE TABLE public.league_versions (
  league_id uuid PRIMARY KEY REFERENCES public.leagues(id) ON DELETE CASCADE,
  version bigint NOT NULL DEFAULT 0 CHECK(version>=0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reader_ids uuid[] NOT NULL DEFAULT '{}'
);
CREATE TABLE public.league_changes (
  league_id uuid NOT NULL REFERENCES public.league_versions(league_id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK(version>0),
  topic text NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(league_id,version)
);
CREATE TABLE private.league_version_pending (
  transaction_id xid8 NOT NULL,
  league_id uuid NOT NULL,
  topics text[] NOT NULL,
  sources text[] NOT NULL,
  PRIMARY KEY(transaction_id,league_id)
);
ALTER TABLE public.league_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.league_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.league_version_pending ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.league_versions,public.league_changes,private.league_version_pending FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.league_versions,public.league_changes TO service_role;

INSERT INTO public.league_versions(league_id,reader_ids)
  SELECT league.id,CASE WHEN league.deleted_at IS NULL THEN
    ARRAY(SELECT member.user_id FROM public.league_members member WHERE member.league_id=league.id ORDER BY member.user_id)
    ELSE ARRAY[]::uuid[] END FROM public.leagues league;

ALTER TABLE public.league_change_hints DROP CONSTRAINT league_change_hints_topic_check,
  ADD CONSTRAINT league_change_hints_topic_check CHECK(topic IN ('lineup','roster','score','game','stat','player_stats','inventory','resources','version'));

CREATE OR REPLACE FUNCTION private.league_version_enqueue(p_league_id uuid,p_topic text,p_source text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO private.league_version_pending AS pending(transaction_id,league_id,topics,sources)
    VALUES(pg_current_xact_id(),p_league_id,ARRAY[p_topic],ARRAY[p_source])
  ON CONFLICT(transaction_id,league_id) DO UPDATE SET
    topics=ARRAY(SELECT DISTINCT unnest(pending.topics||EXCLUDED.topics) ORDER BY 1),
    sources=ARRAY(SELECT DISTINCT unnest(pending.sources||EXCLUDED.sources) ORDER BY 1);
$$;

CREATE OR REPLACE FUNCTION private.league_version_capture()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed_sql text; leagues_sql text; affected record;
  ignored text[] := ARRAY['updated_at','set_at'];
BEGIN
  IF TG_TABLE_NAME='profiles' THEN ignored := ignored||ARRAY['push_token','push_token_revocation_hash']; END IF;
  IF TG_TABLE_NAME='nba_games' THEN
    ignored := ignored||ARRAY['live_stats_elapsed_seconds','live_scoreboard_elapsed_seconds','stats_synced_at'];
  END IF;
  IF TG_OP='INSERT' THEN changed_sql := 'SELECT to_jsonb(n) AS data FROM version_new_rows n';
  ELSIF TG_OP='DELETE' THEN changed_sql := 'SELECT to_jsonb(o) AS data FROM version_old_rows o';
  ELSE
    changed_sql := format($rows$
      (SELECT to_jsonb(n)-%L::text[] AS data FROM version_new_rows n
       EXCEPT SELECT to_jsonb(o)-%L::text[] FROM version_old_rows o)
      UNION ALL
      (SELECT to_jsonb(o)-%L::text[] FROM version_old_rows o
       EXCEPT SELECT to_jsonb(n)-%L::text[] FROM version_new_rows n)
    $rows$,ignored,ignored,ignored,ignored);
  END IF;
  CASE TG_ARGV[1]
    WHEN 'league' THEN leagues_sql := 'SELECT (data->>''league_id'')::uuid AS league_id FROM changed';
    WHEN 'user' THEN leagues_sql := 'SELECT member.league_id FROM changed JOIN public.league_members member ON member.user_id=COALESCE((data->>''user_id'')::uuid,(data->>''id'')::uuid)';
    WHEN 'self' THEN leagues_sql := 'SELECT (data->>''id'')::uuid AS league_id FROM changed';
    WHEN 'draft' THEN leagues_sql := 'SELECT draft.league_id FROM changed JOIN public.drafts draft ON draft.id=(data->>''draft_id'')::uuid';
    WHEN 'trade' THEN leagues_sql := 'SELECT trade.league_id FROM changed JOIN public.trades trade ON trade.id=(data->>''trade_id'')::uuid';
    WHEN 'season' THEN leagues_sql := 'SELECT season.league_id FROM changed JOIN public.league_seasons season ON season.season_year=(data->>''season_year'')::integer';
    WHEN 'global' THEN leagues_sql := 'SELECT league.id AS league_id FROM public.leagues league WHERE league.deleted_at IS NULL AND EXISTS(SELECT 1 FROM changed)';
    ELSE RAISE EXCEPTION 'Unsupported league version source: %',TG_TABLE_NAME;
  END CASE;
  FOR affected IN EXECUTE format('WITH changed AS (%s) SELECT DISTINCT league_id FROM (%s) affected WHERE league_id IS NOT NULL ORDER BY league_id',changed_sql,leagues_sql) LOOP
    PERFORM private.league_version_enqueue(affected.league_id,TG_ARGV[0],TG_TABLE_NAME);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.league_version_flush()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE pending record; stored public.league_versions%ROWTYPE; readers uuid[]; change_topic text; change_scope jsonb;
BEGIN
  FOR pending IN SELECT * FROM private.league_version_pending
    WHERE transaction_id=pg_current_xact_id() ORDER BY league_id LOOP
    DELETE FROM private.league_version_pending
      WHERE transaction_id=pending.transaction_id AND league_id=pending.league_id;
    PERFORM 1 FROM public.league_versions WHERE league_id=pending.league_id FOR UPDATE;
    SELECT CASE WHEN league.deleted_at IS NULL
      THEN ARRAY(SELECT member.user_id FROM public.league_members member WHERE member.league_id=league.id ORDER BY member.user_id)
      ELSE ARRAY[]::uuid[] END INTO readers FROM public.leagues league WHERE league.id=pending.league_id;
    IF NOT FOUND THEN CONTINUE; END IF;
    INSERT INTO public.league_versions AS current(league_id,version,reader_ids)
      VALUES(pending.league_id,1,readers)
    ON CONFLICT(league_id) DO UPDATE SET version=current.version+1,updated_at=clock_timestamp(),reader_ids=EXCLUDED.reader_ids
    RETURNING * INTO stored;
    change_topic := CASE WHEN cardinality(pending.topics)=1 THEN pending.topics[1] ELSE 'batch' END;
    change_scope := jsonb_build_object('topics',pending.topics,'tables',pending.sources);
    INSERT INTO public.league_changes(league_id,version,topic,scope,created_at)
      VALUES(stored.league_id,stored.version,change_topic,change_scope,stored.updated_at);
    DELETE FROM public.league_changes WHERE league_id=stored.league_id AND version<=stored.version-128;
    INSERT INTO public.league_change_hints AS hint(league_id,topic,revision,scopes,details,updated_at)
      VALUES(stored.league_id,'version',stored.version,NULL,jsonb_build_array(jsonb_build_object(
        'version',stored.version::text,'topic',change_topic,'scope',change_scope,'created_at',stored.updated_at)),stored.updated_at)
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=EXCLUDED.revision,scopes=NULL,details=EXCLUDED.details,updated_at=EXCLUDED.updated_at;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_league_version(p_league_id uuid,p_user_id uuid,p_since text DEFAULT '0')
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE stored public.league_versions%ROWTYPE; changes jsonb; since_version bigint;
BEGIN
  IF p_since IS NULL OR p_since !~ '^(0|[1-9][0-9]{0,18})$' THEN RAISE EXCEPTION 'Invalid league version' USING ERRCODE='22023'; END IF;
  since_version := p_since::bigint;
  SELECT * INTO stored FROM public.league_versions WHERE league_id=p_league_id;
  IF NOT FOUND OR p_user_id IS NULL OR NOT (p_user_id=ANY(stored.reader_ids)) THEN
    RAISE EXCEPTION 'League not found' USING ERRCODE='42501';
  END IF;
  IF since_version>=stored.version THEN RETURN jsonb_build_object('version',stored.version::text,'changes','[]'::jsonb); END IF;
  IF since_version<stored.version-128 THEN
    changes := jsonb_build_array(jsonb_build_object('version',stored.version::text,'topic','catchup','scope','{}'::jsonb,'created_at',stored.updated_at));
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object('version',version::text,'topic',topic,'scope',scope,'created_at',created_at) ORDER BY version),'[]'::jsonb)
      INTO changes FROM public.league_changes WHERE league_id=p_league_id AND version>since_version AND version<=stored.version;
  END IF;
  RETURN jsonb_build_object('version',stored.version::text,'changes',changes);
END;
$$;

CREATE OR REPLACE FUNCTION private.emit_league_inventory_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_rows text; v_details text; v_change record;
BEGIN
  IF TG_OP='INSERT' THEN v_rows := 'SELECT * FROM new_rows';
  ELSIF TG_OP='DELETE' THEN v_rows := 'SELECT * FROM old_rows';
  ELSE
    v_rows := $rows$SELECT n.* FROM new_rows n LEFT JOIN old_rows o USING(id)
      WHERE (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')
      UNION ALL SELECT o.* FROM old_rows o LEFT JOIN new_rows n USING(id)
      WHERE (to_jsonb(n)-'updated_at') IS DISTINCT FROM (to_jsonb(o)-'updated_at')$rows$;
  END IF;
  FOR v_change IN EXECUTE format('WITH changed AS (%s) SELECT DISTINCT league_id FROM changed ORDER BY league_id',v_rows) LOOP
    PERFORM private.league_version_enqueue(v_change.league_id,
      CASE WHEN TG_TABLE_NAME='waiver_claims' THEN 'claims' ELSE 'inventory' END,TG_TABLE_NAME);
  END LOOP;
  CASE TG_TABLE_NAME
    WHEN 'draft_picks' THEN
      v_details := $details$SELECT pick.league_id,
        CASE WHEN season.id IS NOT NULL THEN jsonb_build_object(
          'resource','picks','season_id',season.id,'member_id',pick.current_owner_id) END AS detail
        FROM changed pick LEFT JOIN public.league_seasons season
          ON season.league_id=pick.league_id AND season.season_year=pick.season_year$details$;
    WHEN 'waiver_claims' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','claims','season_id',league_season_id) AS detail FROM changed WHERE status NOT IN ('pending','cancelled')$details$;
    WHEN 'waiver_wire_log' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','waivers','season_id',league_season_id) AS detail FROM changed$details$;
    WHEN 'waiver_priorities' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','priority','season_id',league_season_id,'member_id',member_id) AS detail FROM changed$details$;
    WHEN 'faab_balances' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','faab','season_id',league_season_id,'member_id',member_id) AS detail FROM changed$details$;
    WHEN 'league_seasons' THEN
      v_details := $details$SELECT league_id,jsonb_build_object('resource','season','season_id',id) AS detail FROM changed$details$;
    ELSE
      v_details := 'SELECT league_id,NULL::jsonb AS detail FROM changed';
  END CASE;
  FOR v_change IN EXECUTE format($query$
    WITH changed AS (%s),details AS (%s),distinct_details AS (
      SELECT DISTINCT details.league_id,details.detail FROM details
      JOIN public.leagues league ON league.id=details.league_id AND league.deleted_at IS NULL
    ) SELECT league_id,CASE WHEN count(*)<=16 AND bool_and(detail IS NOT NULL)
        THEN jsonb_agg(detail ORDER BY detail::text) END AS details
      FROM distinct_details GROUP BY league_id ORDER BY league_id
  $query$,v_rows,v_details) LOOP
    PERFORM private.publish_league_inventory_hint(v_change.league_id,v_change.details);
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.league_version_enqueue(uuid,text,text),private.league_version_capture(),private.league_version_flush() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_league_version(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_league_version(uuid,uuid,text) TO service_role;

CREATE CONSTRAINT TRIGGER league_version_commit AFTER INSERT ON private.league_version_pending
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.league_version_flush();

CREATE TRIGGER league_version_insert AFTER INSERT ON public.roster_players
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('roster','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.roster_players
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('roster','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.roster_players
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('roster','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.roster_transactions
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('roster','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.roster_transactions
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('roster','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.roster_transactions
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('roster','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.league_player_taxi_exits
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('roster','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.league_player_taxi_exits
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('roster','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.league_player_taxi_exits
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('roster','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.league_member_taxi_exits
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('roster','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.league_member_taxi_exits
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('roster','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.league_member_taxi_exits
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('roster','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.weekly_lineups
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('lineup','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.weekly_lineups
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('lineup','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.weekly_lineups
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('lineup','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.lineup_optimizer_settings
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('lineup','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.lineup_optimizer_settings
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('lineup','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.lineup_optimizer_settings
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('lineup','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.lineup_slot_templates
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('lineup','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.lineup_slot_templates
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('lineup','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.lineup_slot_templates
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('lineup','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.matchups
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('score','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.matchups
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('score','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.matchups
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('score','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.standings
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('score','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.standings
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('score','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.standings
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('score','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.league_members
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('members','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.league_members
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('members','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.league_members
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('members','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.drafts
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.drafts
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.drafts
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.draft_audit_logs
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.draft_audit_logs
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.draft_audit_logs
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.bids
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.bids
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.bids
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.weekly_add_counts
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('claims','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.weekly_add_counts
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('claims','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.weekly_add_counts
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('claims','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.league_activity
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('activity','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.league_activity
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('activity','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.league_activity
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('activity','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.league_announcements
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('activity','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.league_announcements
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('activity','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.league_announcements
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('activity','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.trades
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.trades
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.trades
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.trade_items
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.trade_items
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.trade_items
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.trade_participants
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.trade_participants
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.trade_participants
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.trade_vetos
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.trade_vetos
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.trade_vetos
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.trade_block_items
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.trade_block_items
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.trade_block_items
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.trade_estimate_quotes
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.trade_estimate_quotes
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.trade_estimate_quotes
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.matchup_forecasts
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('forecast','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.matchup_forecasts
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('forecast','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.matchup_forecasts
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('forecast','league');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.leagues
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('settings','self');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.leagues
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('settings','self');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.leagues
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('settings','self');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.draft_budgets
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','draft');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.draft_budgets
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','draft');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.draft_budgets
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','draft');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.draft_orders
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','draft');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.draft_orders
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','draft');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.draft_orders
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','draft');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.draft_room_members
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','draft');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.draft_room_members
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','draft');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.draft_room_members
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','draft');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.nominations
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','draft');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.nominations
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','draft');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.nominations
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','draft');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.snake_draft_picks
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','draft');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.snake_draft_picks
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','draft');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.snake_draft_picks
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('draft','draft');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.trade_estimates
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','trade');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.trade_estimates
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','trade');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.trade_estimates
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('trade','trade');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.nba_games
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('game','season');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.nba_games
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('game','season');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.nba_games
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('game','season');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.game_calendar_corrections
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('game','season');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.game_calendar_corrections
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('game','season');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.game_calendar_corrections
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('game','season');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.season_weeks
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('game','season');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.season_weeks
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('game','season');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.season_weeks
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('game','season');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.player_game_stats
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('stat','season');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.player_game_stats
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('stat','season');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.player_game_stats
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('stat','season');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.player_projections
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('projections','season');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.player_projections
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('projections','season');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.player_projections
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('projections','season');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.sleeper_projection_rows
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('projections','season');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.sleeper_projection_rows
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('projections','season');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.sleeper_projection_rows
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('projections','season');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.players
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('players','global');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.players
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('players','global');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.players
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('players','global');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.dynasty_rankings
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('players','global');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.dynasty_rankings
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('players','global');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.dynasty_rankings
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('players','global');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.dynasty_news
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('players','global');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.dynasty_news
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('players','global');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.dynasty_news
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('players','global');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.projection_sync_runs
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('projections','global');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.projection_sync_runs
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('projections','global');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.projection_sync_runs
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('projections','global');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.fantasypros_projection_rows
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('projections','global');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.fantasypros_projection_rows
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('projections','global');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.fantasypros_projection_rows
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('projections','global');
CREATE TRIGGER league_version_insert AFTER INSERT ON analytics.search_cache_refresh_state
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('resources','global');
CREATE TRIGGER league_version_update AFTER UPDATE ON analytics.search_cache_refresh_state
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('resources','global');
CREATE TRIGGER league_version_delete AFTER DELETE ON analytics.search_cache_refresh_state
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('resources','global');

CREATE TRIGGER league_version_insert AFTER INSERT ON public.profiles
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('members','user');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.profiles
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('members','user');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.profiles
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('members','user');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.notification_preferences
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('settings','user');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.notification_preferences
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('settings','user');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.notification_preferences
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('settings','user');
CREATE TRIGGER league_version_insert AFTER INSERT ON public.player_watches
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('activity','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.player_watches
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('activity','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.player_watches
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('activity','league');

CREATE TRIGGER league_version_insert AFTER INSERT ON public.league_audit_logs
  REFERENCING NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('activity','league');
CREATE TRIGGER league_version_update AFTER UPDATE ON public.league_audit_logs
  REFERENCING OLD TABLE AS version_old_rows NEW TABLE AS version_new_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('activity','league');
CREATE TRIGGER league_version_delete AFTER DELETE ON public.league_audit_logs
  REFERENCING OLD TABLE AS version_old_rows FOR EACH STATEMENT EXECUTE FUNCTION private.league_version_capture('activity','league');

RESET statement_timeout;
RESET lock_timeout;
