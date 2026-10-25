BEGIN;
\ir rules-support.sql

CREATE TEMP TABLE legacy_fixture_players AS
SELECT label, gen_random_uuid() AS id, (900 + row_number() OVER ())::text AS suffix, removed
FROM (VALUES
  ('unreferenced', true),
  ('roster', false),
  ('first_name', false),
  ('last_name', false),
  ('sleeper_id', false),
  ('nba_id', false),
  ('sportsdata_id', false),
  ('restrict', false),
  ('no_action', false),
  ('cascade', true),
  ('set_null', true),
  ('null_marker', false)
) AS fixtures(label, removed);

INSERT INTO public.players(id, first_name, last_name, sleeper_id, nba_id, sportsdata_id, position, eligible_positions)
SELECT id,
  CASE WHEN label = 'first_name' THEN 'Jordan' ELSE 'E2E' END,
  'Player' || suffix || CASE WHEN label = 'last_name' THEN 'x' ELSE '' END,
  'e2e-sleeper-' || suffix || CASE WHEN label = 'sleeper_id' THEN 'x' ELSE '' END,
  CASE WHEN label = 'null_marker' THEN NULL ELSE 'E2ENBA' || suffix || CASE WHEN label = 'nba_id' THEN 'x' ELSE '' END END,
  CASE WHEN label = 'sportsdata_id' THEN 'real-player-' ELSE 'e2e-player-' END || suffix,
  'PG', ARRAY['PG']
FROM legacy_fixture_players;

CREATE TEMP TABLE legacy_fixture_league AS SELECT * FROM pg_temp.rules_fixture(1, 9598);
INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
SELECT league_id, season_id, member_ids[1], player.id, 'draft'
FROM legacy_fixture_league CROSS JOIN legacy_fixture_players player WHERE player.label = 'roster';

CREATE TABLE public.legacy_fixture_restrict(player_id uuid REFERENCES public.players(id) ON DELETE RESTRICT);
CREATE TABLE public.legacy_fixture_no_action(player_id uuid REFERENCES public.players(id) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE public.legacy_fixture_cascade(player_id uuid REFERENCES public.players(id) ON DELETE CASCADE);
CREATE TABLE public.legacy_fixture_set_null(player_id uuid REFERENCES public.players(id) ON DELETE SET NULL);
INSERT INTO public.legacy_fixture_restrict SELECT id FROM legacy_fixture_players WHERE label = 'restrict';
INSERT INTO public.legacy_fixture_no_action SELECT id FROM legacy_fixture_players WHERE label = 'no_action';
INSERT INTO public.legacy_fixture_cascade SELECT id FROM legacy_fixture_players WHERE label = 'cascade';
INSERT INTO public.legacy_fixture_set_null SELECT id FROM legacy_fixture_players WHERE label = 'set_null';

\ir ../../supabase/migrations/20261026001000_remove_e2e_fixture_players.sql

SELECT pg_temp.check_rules(
  EXISTS(SELECT 1 FROM public.players player WHERE player.id = fixture.id) = NOT fixture.removed,
  fixture.label || CASE WHEN fixture.removed THEN ' is deleted' ELSE ' is kept' END
) FROM legacy_fixture_players fixture;
SELECT pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.legacy_fixture_cascade), 'cascade reference is deleted');
SELECT pg_temp.check_rules(EXISTS(SELECT 1 FROM public.legacy_fixture_set_null WHERE player_id IS NULL), 'set-null reference is cleared');
SET CONSTRAINTS ALL IMMEDIATE;

CREATE TEMP TABLE legacy_fixture_after_first_run AS SELECT * FROM public.players;
\ir ../../supabase/migrations/20261026001000_remove_e2e_fixture_players.sql
SELECT pg_temp.check_rules(NOT EXISTS(
  (TABLE public.players EXCEPT TABLE legacy_fixture_after_first_run)
  UNION ALL (TABLE legacy_fixture_after_first_run EXCEPT TABLE public.players)
), 'second run preserves every remaining player');

SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
