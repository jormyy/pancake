BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE mention_fixture AS SELECT * FROM pg_temp.rules_fixture(2,9572);
DO $$
DECLARE f record; player uuid:=gen_random_uuid(); second uuid:=gen_random_uuid(); activity uuid; saved jsonb; visible jsonb;
BEGIN
 SELECT * INTO f FROM mention_fixture;
 INSERT INTO players(id,first_name,last_name,nba_team) VALUES(player,'Mention','Player','BOS');
 activity:=private.log_league_activity(f.league_id,f.season_id,'player_injured','Injury update','Mention Player is out.',f.member_ids[1],NULL,player);
 SELECT metadata->'player_mentions' INTO saved FROM league_activity WHERE id=activity;
 IF saved IS DISTINCT FROM jsonb_build_array(jsonb_build_object('id',player,'name','Mention Player')) THEN
  RAISE EXCEPTION 'Activity payload loses player identity';
 END IF;
 INSERT INTO players(id,first_name,last_name,nba_team) VALUES(second,'Mention','Player','LAL');
 activity:=private.log_league_activity(f.league_id,f.season_id,'player_injured','Two players','Mention Player and Mention Player',f.member_ids[1],NULL,player,NULL,NULL,jsonb_build_object('player_mentions',jsonb_build_array(jsonb_build_object('id',player),jsonb_build_object('id',second))));
 SELECT metadata->'player_mentions' INTO saved FROM league_activity WHERE id=activity;
 IF jsonb_array_length(saved)<>2 OR NOT saved @> jsonb_build_array(jsonb_build_object('id',player,'name','Mention Player'),jsonb_build_object('id',second,'name','Mention Player')) THEN
  RAISE EXCEPTION 'Multiple player mentions lose identity';
 END IF;
 PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
 SELECT to_jsonb(row)->'player_mentions' INTO visible FROM public.get_league_activity_feed(f.league_id) row WHERE id=activity;
 IF visible IS DISTINCT FROM saved THEN RAISE EXCEPTION 'Feed drops saved player mentions'; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.view_activity(f.league_id,f.member_ids[1])->'rows') row WHERE row->>'id'=activity::text AND row->'playerMentions'=saved) THEN
  RAISE EXCEPTION 'Activity view drops player mentions';
 END IF;
END;
$$;
ROLLBACK;
