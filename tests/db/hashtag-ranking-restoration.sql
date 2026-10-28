BEGIN;
\ir rules-support.sql

CREATE TEMP TABLE hashtag_fixture AS SELECT * FROM pg_temp.rules_fixture(2, public.current_season_year_et(), 'active');
CREATE TEMP TABLE hashtag_players AS
  SELECT gen_random_uuid() AS ranked_id, gen_random_uuid() AS trade_only_id;
INSERT INTO public.players(id, sportsdata_id, first_name, last_name, nba_team, position,
  dynasty_rank, dynasty_rank_source, dynasty_rank_fetched_at)
SELECT ranked_id, 'hashtag-restoration-ranked', 'Hashtag', 'Ranked', 'DAL', 'PG'::public.nba_position, 1, 'onenumberhoops.com', now()
  FROM hashtag_players
UNION ALL
SELECT trade_only_id, 'hashtag-restoration-trade-only', 'Trade', 'Only', 'DAL', 'PG'::public.nba_position, 2, 'onenumberhoops.com', now()
  FROM hashtag_players;
INSERT INTO public.dynasty_rankings(source, source_rank, source_player_name, player_id, points, age, fetched_at)
SELECT 'hashtagbasketball.com', 9001, 'Hashtag Ranked', ranked_id, 31.7, 22, '2026-10-27 23:00 UTC'::timestamptz FROM hashtag_players
UNION ALL
SELECT 'hashtagbasketball.com/points-3', 9002, 'Hashtag Ranked', ranked_id, 29.1, 22, '2026-10-27 23:00 UTC'::timestamptz FROM hashtag_players
UNION ALL
SELECT 'hashtagbasketball.com/rookie', 9003, 'Hashtag Ranked', ranked_id, NULL, 22, '2026-10-27 23:00 UTC'::timestamptz FROM hashtag_players
UNION ALL
SELECT 'onenumberhoops.com', 9004, 'Hashtag Ranked', ranked_id, NULL, 40, now() FROM hashtag_players
UNION ALL
SELECT 'onenumberhoops.com', 9005, 'Trade Only', trade_only_id, NULL, 40, now() FROM hashtag_players;
UPDATE public.dynasty_rankings SET trade_value = 999.9 WHERE source='onenumberhoops.com' AND source_rank IN (9004,9005);
CREATE TEMP TABLE hashtag_trade_before AS SELECT * FROM public.dynasty_rankings WHERE source='onenumberhoops.com';
CREATE TEMP TABLE hashtag_picks_before AS TABLE public.dynasty_pick_values;
DELETE FROM private.work_items WHERE kind='sync-rankings';
DELETE FROM private.work_kinds WHERE kind='sync-rankings';
\ir ../../supabase/migrations/20261129000100_restore_hashtag_rankings.sql
\ir ../../supabase/migrations/20261130000100_player_page_speed.sql

DO $$
DECLARE fixture record; players record; forecast record; profile jsonb; inputs jsonb; trade_id uuid;
BEGIN
  SELECT * INTO fixture FROM hashtag_fixture;
  SELECT * INTO players FROM hashtag_players;
  PERFORM pg_temp.check_rules((SELECT dynasty_rank=9001 AND dynasty_rank_source='hashtagbasketball.com'
    AND dynasty_rank_fetched_at='2026-10-27 23:00 UTC'::timestamptz FROM public.players WHERE id=players.ranked_id),
    'migration restores the retained Hashtag rank immediately');
  PERFORM pg_temp.check_rules((SELECT dynasty_rank IS NULL AND dynasty_rank_source IS NULL
    AND dynasty_rank_fetched_at IS NULL FROM public.players WHERE id=players.trade_only_id),
    'migration clears a trade-only screen rank');
  PERFORM pg_temp.check_rules(NOT EXISTS((SELECT * FROM public.dynasty_rankings WHERE source='onenumberhoops.com'
    EXCEPT SELECT * FROM hashtag_trade_before) UNION ALL
    (SELECT * FROM hashtag_trade_before EXCEPT SELECT * FROM public.dynasty_rankings WHERE source='onenumberhoops.com')),
    'migration preserves every OneNumberHoops player row');
  PERFORM pg_temp.check_rules(NOT EXISTS((SELECT * FROM public.dynasty_pick_values EXCEPT SELECT * FROM hashtag_picks_before)
    UNION ALL (SELECT * FROM hashtag_picks_before EXCEPT SELECT * FROM public.dynasty_pick_values)),
    'migration preserves every trade pick value');
  PERFORM set_config('request.jwt.claim.sub',fixture.user_ids[1]::text,true);
  SELECT * INTO forecast FROM public.get_dynasty_forecast_inputs(fixture.league_id,fixture.member_ids[1],
    public.current_season_year_et(),ARRAY[players.ranked_id]);
  PERFORM pg_temp.check_rules(forecast.ranking_source='hashtagbasketball.com' AND forecast.five_year_rank=9001
    AND forecast.three_year_rank=9002 AND forecast.rookie_rank=9003 AND forecast.trade_value IS NULL,
    'all three forecast ranks use Hashtag when a newer trade row exists');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.get_dynasty_forecast_inputs(fixture.league_id,
    fixture.member_ids[1]) WHERE player_id=players.trade_only_id), 'trade-only players do not enter the ranking list');
  FOREACH profile IN ARRAY ARRAY[
    public.view_player(fixture.league_id,fixture.member_ids[1],jsonb_build_object('playerId',players.ranked_id,'section','overview')),
    public.view_player(fixture.league_id,fixture.member_ids[1],jsonb_build_object('playerId',players.ranked_id))
  ] LOOP
    PERFORM pg_temp.check_rules((profile->'player'->>'five_year_points')::numeric=31.7
      AND (profile->'player'->>'three_year_points')::numeric=29.1
      AND (profile->'player'->>'dynasty_rank')::int=9001 AND NOT (profile->'player' ? 'trade_value'),
      'player view renders Hashtag forecasts for '||COALESCE(profile->'pickup'->>'status','full'));
  END LOOP;
  inputs:=private.build_trade_estimate_inputs(fixture.user_ids[1],fixture.member_ids[1],jsonb_build_array(jsonb_build_object(
    'fromMemberId',fixture.member_ids[1],'toMemberId',fixture.member_ids[2],'playerId',players.ranked_id)),false);
  PERFORM pg_temp.check_rules((inputs->'players'->0->>'trade_value')::numeric=999.9
    AND inputs->'players'->0->>'ranking_source'='onenumberhoops.com'
    AND (inputs->'players'->0->>'five_year_rank')::int=9004,
    'live estimates keep OneNumberHoops player values and source metadata');
  INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id,status)
    VALUES(fixture.league_id,fixture.season_id,fixture.member_ids[1],fixture.member_ids[2],'pending') RETURNING id INTO trade_id;
  INSERT INTO public.trade_items(trade_id,side,player_id,from_member_id,to_member_id)
    VALUES(trade_id,'proposer',players.ranked_id,fixture.member_ids[1],fixture.member_ids[2]);
  inputs:=public.get_trade_estimate_reanalysis_inputs(trade_id,'hashtag-restoration');
  PERFORM pg_temp.check_rules((inputs->'players'->0->>'trade_value')::numeric=999.9
    AND inputs->'players'->0->>'ranking_source'='onenumberhoops.com',
    'historical re-analysis keeps OneNumberHoops player values');
  UPDATE public.dynasty_rankings SET player_id=NULL,source_player_id='hashtag-restoration-review'
    WHERE source='onenumberhoops.com' AND source_rank=9004;
  INSERT INTO public.trade_value_reviews(source_id,source_name,source_team,source_positions,trade_value,reason,candidate_ids,fetched_at)
    VALUES('hashtag-restoration-review','Hashtag Ranked','DAL',ARRAY['PG'],999.9,'fixture',ARRAY[players.ranked_id],now());
  PERFORM public.resolve_trade_value_review('hashtag-restoration-review',players.ranked_id);
  PERFORM pg_temp.check_rules((SELECT dynasty_rank=9001 AND dynasty_rank_source='hashtagbasketball.com'
    FROM public.players WHERE id=players.ranked_id), 'trade match review preserves the Hashtag screen rank');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
