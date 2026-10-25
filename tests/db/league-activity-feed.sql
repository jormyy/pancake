BEGIN;
DO $$
DECLARE
  u uuid := gen_random_uuid(); l uuid := gen_random_uuid(); s uuid := gen_random_uuid();
  m uuid := gen_random_uuid(); p uuid := gen_random_uuid();
  added uuid := gen_random_uuid(); normal uuid := gen_random_uuid();
  result uuid[];
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,u::text||'@example.test','{}');
  INSERT INTO leagues(id,name,slug,commissioner_id,status)
    VALUES(l,'Activity feed',l::text,u,'active');
  INSERT INTO league_members(id,league_id,user_id,team_name) VALUES(m,l,u,'Feed team');
  INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(s,l,2097,true);
  INSERT INTO players(id,first_name,last_name,position,eligible_positions)
    VALUES(p,'Feed','Player','PG',ARRAY['PG']);
  INSERT INTO roster_transactions(id,league_id,league_season_id,member_id,player_id,transaction_type,occurred_at)
    VALUES(added,l,s,m,p,'fa_add',now()-interval '2 minutes');
  INSERT INTO league_activity(id,league_id,league_season_id,actor_member_id,event_type,title,created_at)
    VALUES(normal,l,s,m,'trade_completed','Trade completed',now()-interval '1 minute');
  INSERT INTO league_activity(league_id,league_season_id,actor_member_id,event_type,title,created_at)
    VALUES(l,s,m,'trade_countered','Private offer',now()),
      (l,s,m,'trade_block_updated','Player listed',now()),
      (l,NULL,m,'trade_block_updated','Listing removed',now()+interval '1 minute');
  PERFORM set_config('request.jwt.claim.sub',u::text,true);
  SELECT array_agg(feed.id ORDER BY feed.occurred_at DESC, feed.id DESC) INTO result
    FROM public.get_league_activity_feed(l,2,0) AS feed;
  IF result IS DISTINCT FROM ARRAY[normal,added] THEN
    RAISE EXCEPTION 'Trade-block listings displace normal activity: %',result;
  END IF;
  SELECT array_agg(feed.id) INTO result FROM public.get_league_activity_feed(l,1,1) AS feed;
  IF result IS DISTINCT FROM ARRAY[added] THEN
    RAISE EXCEPTION 'Activity offset includes hidden listings: %',result;
  END IF;
  IF EXISTS(SELECT 1 FROM public.get_league_activity_feed(l,50,0) WHERE transaction_type IN ('trade_block_updated','trade_countered')) THEN
    RAISE EXCEPTION 'Activity includes hidden listings or private offers';
  END IF;
END;
$$;
ROLLBACK;
