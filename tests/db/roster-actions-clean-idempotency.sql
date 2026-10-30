BEGIN;
CREATE TEMP TABLE ra_retry_users ON COMMIT DROP AS
SELECT member.user_id,member.league_id FROM public.league_members member
JOIN public.league_seasons season ON season.league_id=member.league_id
JOIN public.leagues league ON league.id=member.league_id
WHERE season.season_year=2901 AND league.name='Rules fixture';
DELETE FROM private.request_receipts WHERE actor IN(SELECT user_id FROM ra_retry_users);
DELETE FROM public.leagues WHERE id IN(SELECT league_id FROM ra_retry_users);
DELETE FROM auth.users WHERE id IN(SELECT user_id FROM ra_retry_users);
DELETE FROM public.players WHERE first_name='Retry' AND last_name ~ '^(1[012]|[1-9])$' AND nba_id IS NULL;
DROP SCHEMA IF EXISTS idempotency_test CASCADE;
COMMIT;
