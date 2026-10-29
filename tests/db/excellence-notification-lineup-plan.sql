\set ON_ERROR_STOP on
\if :{?scoped}
\else
  \set scoped true
\endif
BEGIN;
\ir excellence-fixture.sql
SET LOCAL statement_timeout='120s';
SET LOCAL lock_timeout='500ms';
SET LOCAL jit=off;
CREATE TEMP TABLE notification_cases AS
SELECT member.id AS member_id,member.league_id,slot.at
FROM public.league_members member
CROSS JOIN (VALUES ('2026-10-28 22:00:00+00'::timestamptz),('2026-10-29 23:00:00+00'::timestamptz),('2026-10-30 22:00:00+00'::timestamptz)) slot(at);
\if :scoped
EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
SELECT count(*) FROM notification_cases cases CROSS JOIN generate_series(1,10) repetition
CROSS JOIN LATERAL private.notif_lineup_candidates_scoped(cases.at,cases.league_id,cases.member_id) candidate;
SELECT md5(coalesce(jsonb_agg(to_jsonb(candidate) ORDER BY cases.at,cases.member_id,candidate.event_type,candidate.player_id)::text,'')) AS result_hash
FROM notification_cases cases
CROSS JOIN LATERAL private.notif_lineup_candidates_scoped(cases.at,cases.league_id,cases.member_id) candidate;
DO $$
DECLARE sample record;
BEGIN
  FOR sample IN SELECT at,league_id,member_id FROM notification_cases LOOP
    IF EXISTS(
      (SELECT event_type,league_id,member_id,player_id,game_date FROM private.notif_lineup_candidates(sample.at)
       WHERE league_id=sample.league_id AND member_id=sample.member_id
       EXCEPT ALL SELECT event_type,league_id,member_id,player_id,game_date
       FROM private.notif_lineup_candidates_scoped(sample.at,sample.league_id,sample.member_id))
      UNION ALL
      (SELECT event_type,league_id,member_id,player_id,game_date FROM private.notif_lineup_candidates_scoped(sample.at,sample.league_id,sample.member_id)
       EXCEPT ALL SELECT event_type,league_id,member_id,player_id,game_date FROM private.notif_lineup_candidates(sample.at)
       WHERE league_id=sample.league_id AND member_id=sample.member_id)
    ) THEN RAISE EXCEPTION 'Scoped notification candidates differ'; END IF;
  END LOOP;
  IF NOT private.notif_is_stale('lineup_empty','{}')
    OR NOT private.notif_is_stale('lineup_inactive','{"leagueId":"invalid","memberId":"invalid"}') THEN
    RAISE EXCEPTION 'Malformed notification identity is not stale';
  END IF;
END;
$$;
\else
EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
SELECT count(*) FROM notification_cases cases CROSS JOIN generate_series(1,10) repetition
CROSS JOIN LATERAL private.notif_lineup_candidates(cases.at) candidate
WHERE candidate.league_id=cases.league_id AND candidate.member_id=cases.member_id;
SELECT md5(coalesce(jsonb_agg(to_jsonb(candidate) ORDER BY cases.at,cases.member_id,candidate.event_type,candidate.player_id)::text,'')) AS result_hash
FROM notification_cases cases
CROSS JOIN LATERAL private.notif_lineup_candidates(cases.at) candidate
WHERE candidate.league_id=cases.league_id AND candidate.member_id=cases.member_id;
\endif
ROLLBACK;
