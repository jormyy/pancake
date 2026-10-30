-- Canonical SQL source for private.publish_league_version.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.publish_league_version(p_league_id uuid,p_topics text[],p_sources text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE stored public.league_versions%ROWTYPE; readers uuid[]; change_topic text; change_scope jsonb;
BEGIN
    PERFORM 1 FROM public.league_versions WHERE league_id=p_league_id FOR UPDATE;
    SELECT CASE WHEN league.deleted_at IS NULL
      THEN ARRAY(SELECT member.user_id FROM public.league_members member WHERE member.league_id=league.id ORDER BY member.user_id)
      ELSE ARRAY[]::uuid[] END INTO readers FROM public.leagues league WHERE league.id=p_league_id;
    IF NOT FOUND THEN RETURN; END IF;
    INSERT INTO public.league_versions AS current(league_id,version,reader_ids)
      VALUES(p_league_id,1,readers)
    ON CONFLICT(league_id) DO UPDATE SET version=current.version+1,updated_at=clock_timestamp(),reader_ids=EXCLUDED.reader_ids
    RETURNING league_id,version,updated_at,reader_ids INTO stored;
    change_topic := CASE WHEN cardinality(p_topics)=1 THEN p_topics[1] ELSE 'batch' END;
    change_scope := jsonb_build_object('topics',p_topics,'tables',p_sources);
    INSERT INTO public.league_changes(league_id,version,topic,scope,created_at)
      VALUES(stored.league_id,stored.version,change_topic,change_scope,stored.updated_at);
    DELETE FROM public.league_changes WHERE league_id=stored.league_id AND version<=stored.version-128;
    INSERT INTO public.league_change_hints AS hint(league_id,topic,revision,scopes,details,updated_at)
      VALUES(stored.league_id,'version',stored.version,NULL,jsonb_build_array(jsonb_build_object(
        'version',stored.version::text,'topic',change_topic,'scope',change_scope,'created_at',stored.updated_at)),stored.updated_at)
    ON CONFLICT(league_id,topic) DO UPDATE SET revision=EXCLUDED.revision,scopes=NULL,details=EXCLUDED.details,updated_at=EXCLUDED.updated_at;
END;
$$;
