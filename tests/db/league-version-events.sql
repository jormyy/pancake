\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE event_version_fixture AS SELECT * FROM pg_temp.rules_fixture(2,9594);
CREATE TEMP TABLE other_event_version_fixture AS SELECT * FROM pg_temp.rules_fixture(2,9595);
SET CONSTRAINTS private.league_version_commit IMMEDIATE;
CREATE PROCEDURE pg_temp.event_version_write(p_label text,p_command text,p_expected integer DEFAULT 1)
LANGUAGE plpgsql AS $$
DECLARE f record; before_version bigint; response jsonb;
BEGIN
  SELECT * INTO f FROM event_version_fixture;
  SELECT version INTO before_version FROM public.league_versions WHERE league_id=f.league_id;
  EXECUTE p_command;
  PERFORM pg_temp.check_rules((SELECT version=before_version+p_expected FROM public.league_versions WHERE league_id=f.league_id),p_label);
  PERFORM pg_temp.check_rules((SELECT revision=before_version+p_expected FROM public.league_change_hints WHERE league_id=f.league_id AND topic='version'),p_label||' publishes the committed version');
  response:=public.get_league_version(f.league_id,f.user_ids[1],before_version::text);
  PERFORM pg_temp.check_rules(response->>'version'=(before_version+p_expected)::text AND jsonb_array_length(response->'changes')=p_expected,p_label||' reaches the version reader');
END;
$$;
CALL pg_temp.event_version_write('event-only insert', $cmd$
  INSERT INTO public.league_events(league_id,member_id,kind,summary)
  SELECT league_id,member_ids[1],'lineup.auto_set','Event version probe' FROM event_version_fixture
$cmd$);
SELECT set_config('request.jwt.claim.sub',(SELECT user_ids[1]::text FROM event_version_fixture),true) \gset
SELECT pg_temp.check_rules((SELECT public.view_team_timeline(league_id,member_ids[1])->'events'->0->>'summary'='Event version probe' FROM event_version_fixture),'versioned insert reaches the team timeline');
SELECT pg_temp.check_rules((SELECT scope->'tables' ? 'league_events' AND topic='activity' FROM public.league_changes WHERE league_id=(SELECT league_id FROM event_version_fixture) ORDER BY version DESC LIMIT 1),'event version identifies its source');
CALL pg_temp.event_version_write('event-only update', $cmd$
  UPDATE public.league_events SET summary='Changed event' WHERE league_id=(SELECT league_id FROM event_version_fixture)
$cmd$);
SELECT pg_temp.check_rules((SELECT public.view_team_timeline(league_id,member_ids[1])->'events'->0->>'summary'='Changed event' FROM event_version_fixture),'versioned update reaches the team timeline');
CALL pg_temp.event_version_write('unchanged event', $cmd$
  UPDATE public.league_events SET summary=summary WHERE league_id=(SELECT league_id FROM event_version_fixture)
$cmd$,0);
CALL pg_temp.event_version_write('unscoped worker event', $cmd$
  INSERT INTO public.league_events(kind,summary) VALUES('work.succeeded','Global maintenance')
$cmd$,0);
CALL pg_temp.event_version_write('empty event write', $cmd$
  DELETE FROM public.league_events WHERE false
$cmd$,0);
CALL pg_temp.event_version_write('event-only delete', $cmd$
  DELETE FROM public.league_events WHERE league_id=(SELECT league_id FROM event_version_fixture)
$cmd$);
SELECT pg_temp.check_rules((SELECT public.view_team_timeline(league_id,member_ids[1])->'events'='[]'::jsonb FROM event_version_fixture),'versioned delete reaches the team timeline');
DO $$
DECLARE f record; other record; before_version bigint; other_version bigint; publication uuid; work_id bigint; token uuid;
BEGIN
  SELECT * INTO f FROM event_version_fixture;
  SELECT * INTO other FROM other_event_version_fixture;
  SELECT version INTO before_version FROM public.league_versions WHERE league_id=f.league_id;
  SELECT version INTO other_version FROM public.league_versions WHERE league_id=other.league_id;
  SET CONSTRAINTS private.league_version_commit DEFERRED;
  INSERT INTO public.league_events(league_id,kind,summary)
    VALUES(f.league_id,'work.succeeded','First'),(f.league_id,'work.succeeded','Second'),(other.league_id,'work.succeeded','Other');
  UPDATE public.league_events SET summary=summary||' changed' WHERE league_id=f.league_id;
  SET CONSTRAINTS private.league_version_commit IMMEDIATE;
  PERFORM pg_temp.check_rules((SELECT version=before_version+1 FROM public.league_versions WHERE league_id=f.league_id),'one transaction bumps each league once');
  PERFORM pg_temp.check_rules((SELECT version=other_version+1 FROM public.league_versions WHERE league_id=other.league_id),'batch includes every affected league');
  before_version:=before_version+1;
  BEGIN
    INSERT INTO public.league_events(league_id,kind,summary) VALUES(f.league_id,'work.dead','Rolled back');
    RAISE EXCEPTION 'Event rollback' USING ERRCODE='V0001';
  EXCEPTION WHEN SQLSTATE 'V0001' THEN NULL;
  END;
  PERFORM pg_temp.check_rules((SELECT version=before_version FROM public.league_versions WHERE league_id=f.league_id),'rolled back events preserve the version');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.league_version_pending),'rollback leaves no pending version');
  PERFORM set_config('pancake.trade_write','true',true);
  INSERT INTO public.league_events(league_id,kind,summary) VALUES(f.league_id,'trade.accepted','Deferred event');
  PERFORM set_config('pancake.trade_write','',true);
  PERFORM pg_temp.check_rules((SELECT version=before_version FROM public.league_versions WHERE league_id=f.league_id),'queued trade event waits for publication');
  SELECT id INTO publication FROM private.trade_publications WHERE league_id=f.league_id;
  PERFORM private.publish_trade_changes(publication);
  PERFORM pg_temp.check_rules((SELECT version>before_version FROM public.league_versions WHERE league_id=f.league_id),'published trade event advances the version');
  SELECT version INTO before_version FROM public.league_versions WHERE league_id=f.league_id;
  DELETE FROM private.work_items;
  work_id:=private.work_enqueue('player-stats-hints','event-version',now(),'{}',f.league_id);
  SELECT lease_token INTO token FROM private.work_claim(1);
  PERFORM private.work_finish(work_id,token);
  PERFORM pg_temp.check_rules((SELECT version=before_version+1 FROM public.league_versions WHERE league_id=f.league_id),'worker completion alone advances its league version');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
