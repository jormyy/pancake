BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE timeline_fixture AS SELECT * FROM pg_temp.rules_fixture(3, 9571);
GRANT SELECT ON timeline_fixture TO authenticated;
DO $$
DECLARE f record; other_league uuid; base_time timestamptz := '2026-10-27 10:00:00.123456+00';
BEGIN
  SELECT * INTO f FROM timeline_fixture;
  INSERT INTO public.league_events(league_id,member_id,kind,summary,detail,created_at) VALUES
    (f.league_id,f.member_ids[1],'claim.awarded','Claim awarded',jsonb_build_object('id','won','bid_amount',17,'player_id',gen_random_uuid()),base_time),
    (f.league_id,f.member_ids[1],'claim.failed','Claim failed',jsonb_build_object('id','lost','bid_amount',9,'failure_reason','Bid tied; the other team has priority.'),base_time),
    (f.league_id,NULL,'trade.sent','Trade sent',jsonb_build_object('id','trade','proposer_member_id',f.member_ids[1],'recipient_member_id',f.member_ids[2],'notes','Private trade note'),base_time),
    (f.league_id,NULL,'trade.countered','Trade countered',jsonb_build_object('id','trade','proposer_member_id',f.member_ids[2],'recipient_member_id',f.member_ids[1]),base_time),
    (f.league_id,NULL,'trade.accepted','Trade accepted',jsonb_build_object('id','trade','proposer_member_id',f.member_ids[2],'recipient_member_id',f.member_ids[1]),base_time),
    (f.league_id,NULL,'trade.executed','Trade executed',jsonb_build_object('id','trade','proposer_member_id',f.member_ids[2],'recipient_member_id',f.member_ids[1],'reason','Review window completed.','notes','Private trade note'),base_time),
    (f.league_id,f.member_ids[1],'lineup.auto_set','Lineup auto-set',jsonb_build_object('game_date',current_date,'assignments','[]'::jsonb),base_time),
    (f.league_id,NULL,'scores.finalized','Scores finalized',jsonb_build_object('id','matchup','home_member_id',f.member_ids[1],'away_member_id',f.member_ids[2],'home_points',150),base_time),
    (f.league_id,f.member_ids[1],'pick.made','Pick made',jsonb_build_object('id','pick','pick_number',1),base_time),
    (f.league_id,NULL,'settings.changed','League settings changed',jsonb_build_object('changes',jsonb_build_object('roster_size',20),'internal_token','secret'),base_time),
    (f.league_id,NULL,'work.dead','Worker failed',jsonb_build_object('error','Internal worker detail'),base_time);
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; result jsonb; second jsonb; all_ids text[] := '{}'; cursor jsonb; iterations int := 0; next_id text;
BEGIN
  SELECT * INTO f FROM timeline_fixture;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  result := public.view_team_timeline(f.league_id,f.member_ids[1],NULL,100);
  PERFORM pg_temp.check_rules(jsonb_array_length(result->'events')=10,'owner sees all ten team outcomes');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'events') e WHERE e->>'kind'='claim.failed'
    AND e->>'reason'='Bid tied; the other team has priority.' AND e->'detail'->>'bid_amount'='9'),'owner sees exact failed bid and reason');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'events') e WHERE e->>'kind' LIKE 'work.%'),'internal queue events stay out');
  PERFORM pg_temp.check_rules(NOT (result->>'hasMore')::boolean AND result->'nextCursor'='null'::jsonb,'last page has no cursor');
  LOOP
    result := public.view_team_timeline(f.league_id,f.member_ids[1],cursor,3);
    iterations := iterations + 1;
    FOR next_id IN SELECT e->>'id' FROM jsonb_array_elements(result->'events') e LOOP
      PERFORM pg_temp.check_rules(NOT next_id=ANY(all_ids),'paged event is unique '||next_id);
      all_ids := array_append(all_ids,next_id);
    END LOOP;
    EXIT WHEN NOT (result->>'hasMore')::boolean;
    cursor := result->'nextCursor';
    PERFORM pg_temp.check_rules(cursor->>'createdAt' LIKE '%.123456%','cursor preserves microseconds page '||iterations);
    IF iterations>10 THEN RAISE EXCEPTION 'Paging did not terminate'; END IF;
  END LOOP;
  PERFORM pg_temp.check_rules(cardinality(all_ids)=10 AND iterations=4,'tied timestamps page without gaps');
  PERFORM pg_temp.check_rules(all_ids = ARRAY(SELECT id::text FROM public.league_events WHERE league_id=f.league_id AND kind<>'work.dead' ORDER BY created_at DESC,public.league_events.id DESC),'pages retain descending stable order');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[2]::text,true);
  result := public.view_team_timeline(f.league_id,f.member_ids[1],NULL,100);
  PERFORM pg_temp.check_rules(jsonb_array_length(result->'events')=9,'counterparty sees public team outcomes and shared trade steps');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'events') e WHERE e->>'kind'='claim.failed'),'counterparty cannot see failed claim');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'events') e WHERE e->'detail' ? 'bid_amount' OR e->'detail' ? 'notes' OR e->'detail' ? 'assignments' OR e->'detail' ? 'internal_token'),'counterparty cannot read private detail');
  second := public.view_team_timeline(f.league_id,f.member_ids[2],NULL,100);
  PERFORM pg_temp.check_rules(jsonb_array_length(second->'events')=6,'other team sees only its trades scores and league settings');
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[3]::text,true);
  result := public.view_team_timeline(f.league_id,f.member_ids[1],NULL,100);
  PERFORM pg_temp.check_rules(jsonb_array_length(result->'events')=6,'observer cannot read pending trade steps');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'events') e WHERE e->>'kind'='trade.executed' AND e->>'reason'='Review window completed.'),'observer sees exact public execution reason');
  PERFORM pg_temp.reject_rules(format('SELECT public.view_team_timeline(%L,%L,NULL,0)',f.league_id,f.member_ids[1]),'%between 1 and 100%','zero limit rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.view_team_timeline(%L,%L,NULL,101)',f.league_id,f.member_ids[1]),'%between 1 and 100%','oversize limit rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.view_team_timeline(%L,%L,''{}''::jsonb)',f.league_id,f.member_ids[1]),'%cursor is invalid%','missing cursor fields rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.view_team_timeline(%L,%L,''{"id":"x","createdAt":"today"}''::jsonb)',f.league_id,f.member_ids[1]),'%cursor is invalid%','invalid cursor identifier rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.view_team_timeline(%L,%L,NULL,30)',f.league_id,gen_random_uuid()),'%not available%','foreign target rejected');
  PERFORM set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  PERFORM pg_temp.reject_rules(format('SELECT public.view_team_timeline(%L,%L,NULL,30)',f.league_id,f.member_ids[1]),'%not available%','outsider rejected');
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM pg_temp.reject_rules(format('SELECT public.view_team_timeline(%L,%L,NULL,30)',f.league_id,f.member_ids[1]),'%not available%','missing identity rejected');
END;
$$;
RESET ROLE;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
