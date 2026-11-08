BEGIN;
\ir rules-support.sql
CREATE TEMP TABLE bounds_fixture AS SELECT * FROM pg_temp.rules_fixture(2,2037);
SET LOCAL session_replication_role=replica;
DO $$
DECLARE
  league uuid; season uuid; members uuid[]; player uuid:=gen_random_uuid(); value jsonb;
BEGIN
  SELECT league_id,season_id,member_ids INTO league,season,members FROM bounds_fixture;
  UPDATE public.leagues SET name=repeat('A',1025),playoff_round_lengths=NULL WHERE id=league;
  UPDATE public.league_members SET team_name=repeat('T',40) WHERE id=members[1];
  INSERT INTO public.players(id,first_name,last_name,nba_id,injury_reason,eligible_positions)
    VALUES(player,repeat('😀',1025),'Player',repeat('N',2000),repeat('R',2000),ARRAY[repeat('P',100)]);
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(league,season,members[1],player,'draft');
  value:=public.public_read_v2(league,'league','{}',repeat('a',64));
  PERFORM pg_temp.check_rules(value->'items'->0->>'name'=repeat('A',1024),'long league remains readable');
  PERFORM pg_temp.check_rules(value->'items'->0->'playoffRoundLengths'='null'::jsonb,'nullable array stays null');
  value:=public.public_read_v2(league,'teams',jsonb_build_object('team',members[1]),repeat('a',64));
  PERFORM pg_temp.check_rules(value->'items'->0->>'name'=repeat('T',40),'constrained team name stays complete');
  value:=public.public_read_v2(league,'players',jsonb_build_object('player',player),repeat('a',64));
  PERFORM pg_temp.check_rules(value->'items'->0->>'name'=repeat('😀',1024),'public text counts Unicode code points');
  PERFORM pg_temp.check_rules(value->'items'->0->>'nbaId'=repeat('N',1024),'external player identifier stays text');
  PERFORM pg_temp.check_rules(value->'items'->0->>'injuryReason'=repeat('R',1024),'long injury reason is bounded');
  PERFORM pg_temp.check_rules(value->'items'->0->'eligiblePositions'->>0=repeat('P',32),'array text is bounded');
  value:=public.public_read_v2(league,'rosters',jsonb_build_object('team',members[1]),repeat('a',64));
  PERFORM pg_temp.check_rules(value->'items'->0->'player'->>'name'=repeat('😀',1024),'nested player text is bounded');
  value:=public.public_read_v2(league,'players',jsonb_build_object('player',player,'query','Player'),repeat('a',64));
  PERFORM pg_temp.check_rules(value->'items'='[]'::jsonb,'search uses the bounded public value');
  PERFORM pg_temp.check_rules((SELECT length(name)=1025 FROM public.leagues WHERE id=league),'stored league is unchanged');
END $$;
SELECT label FROM rules_checks ORDER BY label;
ROLLBACK;
