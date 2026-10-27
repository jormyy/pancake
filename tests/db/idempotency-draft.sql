\ir idempotency-support.sql
UPDATE players SET nba_draft_number=1 WHERE id IN (SELECT id FROM idempotency_players);
CREATE TEMP TABLE idempotency_drafts AS SELECT gen_random_uuid() AS snake, gen_random_uuid() AS auction, gen_random_uuid() AS automatic;
INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds,pick_timer_seconds)
SELECT d.snake,f.league_id,f.season_id,'snake','in_progress',true,1,60 FROM idempotency_drafts d CROSS JOIN idempotency_fixture f;
INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds,pick_timer_seconds)
SELECT d.automatic,f.league_id,f.season_id,'snake','in_progress',true,1,60 FROM idempotency_drafts d CROSS JOIN idempotency_fixture f;
INSERT INTO snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,timer_expires_at)
SELECT d.automatic,1,1,1,f.member_ids[1],now()+interval '1 hour' FROM idempotency_drafts d CROSS JOIN idempotency_fixture f;
INSERT INTO drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds,pick_timer_seconds)
SELECT d.auction,f.league_id,f.season_id,'auction','in_progress',true,1,60 FROM idempotency_drafts d CROSS JOIN idempotency_fixture f;
INSERT INTO snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,timer_expires_at)
SELECT d.snake,1,1,1,f.member_ids[1],now()+interval '1 hour' FROM idempotency_drafts d CROSS JOIN idempotency_fixture f;
INSERT INTO draft_orders(draft_id,member_id,position)
SELECT d.auction,f.member_ids[n],n FROM idempotency_drafts d CROSS JOIN idempotency_fixture f CROSS JOIN generate_series(1,3) n;
INSERT INTO draft_budgets(draft_id,member_id,initial_budget,remaining)
SELECT d.auction,unnest(f.member_ids),200,200 FROM idempotency_drafts d CROSS JOIN idempotency_fixture f;
DO $$
DECLARE f record; d record; player uuid; nomination jsonb;
BEGIN
  SELECT * INTO f FROM idempotency_fixture;
  SELECT * INTO d FROM idempotency_drafts;
  SELECT id INTO player FROM idempotency_players WHERE n=1;
  PERFORM pg_temp.retry('snake pick', f.user_ids[1], format('public.make_snake_pick_atomic(%L,%L,%L,false)',d.snake,f.member_ids[1],player), 'public.make_snake_pick_atomic');
  PERFORM pg_temp.retry('auto pick', f.user_ids[1], format('public.auto_pick_snake_pick_atomic(%L,%L)',d.automatic,f.member_ids[1]), 'public.auto_pick_snake_pick_atomic');
  SELECT id INTO player FROM idempotency_players WHERE n=2;
  nomination := pg_temp.retry('nomination', f.user_ids[1], format('public.create_auction_nomination_atomic(%L,%L,%L,%L,60)',d.auction,f.member_ids[1],player,f.user_ids[1]), 'public.create_auction_nomination_atomic');
  PERFORM pg_temp.retry('bid', f.user_ids[2], format('public.place_auction_bid_atomic(%L,%L,%L,5,%L,false)',d.auction,f.member_ids[2],nomination->>'id',f.user_ids[2]), 'public.place_auction_bid_atomic');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM bids WHERE nomination_id=(nomination->>'id')::uuid), 'one bid');
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM snake_draft_picks WHERE draft_id=d.snake AND player_id IS NOT NULL), 'one pick');
END;
$$;
\ir idempotency-cleanup.sql
