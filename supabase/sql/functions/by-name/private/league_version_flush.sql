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
