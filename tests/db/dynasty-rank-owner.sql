BEGIN;
CREATE TEMP TABLE owner_players AS
  SELECT gen_random_uuid() AS ranked_id, gen_random_uuid() AS winner_id, gen_random_uuid() AS loser_id;
INSERT INTO public.players(id, first_name, last_name, nba_team, dynasty_rank, dynasty_rank_source, dynasty_rank_fetched_at)
SELECT ranked_id, 'Owner', 'Ranked', 'DAL', 7, 'hashtagbasketball.com', '2026-10-27 23:00 UTC'::timestamptz FROM owner_players
UNION ALL SELECT winner_id, 'Owner', 'Winner', 'BOS', NULL, NULL, NULL FROM owner_players
UNION ALL SELECT loser_id, 'Owner', 'Loser', 'BOS', 12, 'hashtagbasketball.com', '2026-10-27 23:00 UTC'::timestamptz FROM owner_players;

DO $$
DECLARE
  ids record;
  rows jsonb;
  picks jsonb;
  expected text := 'players.dynasty_rank is owned by the Hashtag five-year points sync; write trade values to dynasty_rankings with source onenumberhoops.com';
  message text;
  attempt text;
BEGIN
  SELECT * INTO ids FROM owner_players;
  SELECT jsonb_agg(jsonb_build_object('source_id', 'owner-' || n, 'name', 'Owner Value ' || n, 'team', 'DAL',
    'positions', jsonb_build_array('PG'), 'rank', n, 'value', 1000 - n, 'age', 25,
    'player_id', CASE WHEN n = 1 THEN ids.ranked_id END, 'reason', 'fixture', 'candidate_ids', '[]'::jsonb))
    INTO rows FROM generate_series(1, 450) n;
  SELECT jsonb_agg(jsonb_build_object('year', year, 'round', round, 'tier', tier, 'value', 100))
    INTO picks FROM generate_series(2027, 2029) year, generate_series(1, 2) round, unnest(ARRAY['early', 'mid', 'late']) tier;

  PERFORM public.publish_trade_values(rows, picks, 'dynasty-rank-owner', clock_timestamp(), 'json');
  IF NOT (SELECT dynasty_rank = 7 AND dynasty_rank_source = 'hashtagbasketball.com' FROM public.players WHERE id = ids.ranked_id) THEN
    RAISE EXCEPTION 'OneNumberHoops publication changed players.dynasty_rank: %',
      (SELECT jsonb_build_object('rank', dynasty_rank, 'source', dynasty_rank_source) FROM public.players WHERE id = ids.ranked_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.dynasty_rankings WHERE source = 'onenumberhoops.com' AND player_id = ids.ranked_id AND trade_value = 999) THEN
    RAISE EXCEPTION 'OneNumberHoops publication did not store the trade value in dynasty_rankings';
  END IF;

  FOREACH attempt IN ARRAY ARRAY[
    format($q$UPDATE public.players SET dynasty_rank_source = 'onenumberhoops.com' WHERE id = %L$q$, ids.ranked_id),
    format($q$UPDATE public.players SET dynasty_rank = 3, dynasty_rank_source = 'hashtagbasketball.com/points-3' WHERE id = %L$q$, ids.ranked_id),
    format($q$UPDATE public.players SET dynasty_rank = 3, dynasty_rank_source = NULL WHERE id = %L$q$, ids.ranked_id),
    $q$INSERT INTO public.players(first_name, last_name, dynasty_rank, dynasty_rank_source) VALUES ('Owner', 'Insert', 1, 'onenumberhoops.com')$q$
  ] LOOP
    message := NULL;
    BEGIN
      EXECUTE attempt;
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS message = MESSAGE_TEXT;
    END;
    IF message IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'Write was not refused with the ownership error: % (got %)', attempt, message;
    END IF;
  END LOOP;

  UPDATE public.players SET dynasty_rank = 4, dynasty_rank_fetched_at = now() WHERE id = ids.ranked_id;
  UPDATE public.players SET dynasty_rank = NULL, dynasty_rank_source = NULL, dynasty_rank_fetched_at = NULL WHERE id = ids.ranked_id;

  PERFORM public.merge_players(ids.winner_id, ids.loser_id);
  IF NOT (SELECT dynasty_rank = 12 AND dynasty_rank_source = 'hashtagbasketball.com' FROM public.players WHERE id = ids.winner_id) THEN
    RAISE EXCEPTION 'merge_players did not carry the Hashtag rank to the surviving player';
  END IF;
END;
$$;
ROLLBACK;
