import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const database = process.env.SUPABASE_DB_URL
assert.ok(database && new URL(database).hostname === '127.0.0.1' && new URL(database).port === '59722')
assert.ok(process.env.TRADE_BACKUP_PATH)
const backup = readFileSync(process.env.TRADE_BACKUP_PATH, 'utf8')
const tables = ['players', 'leagues', 'league_seasons', 'league_members', 'roster_players']
const imports = tables.map(table => {
    const marker = `INSERT INTO "public"."${table}" `
    const start = backup.indexOf(marker)
    assert.ok(start >= 0, `Missing ${table}`)
    const end = backup.indexOf(';\n', start)
    assert.ok(end > start)
    return `CREATE TEMP TABLE audit_${table} (LIKE public.${table} INCLUDING DEFAULTS);\n` +
        backup.slice(start, end + 1).replace(marker, `INSERT INTO audit_${table} `)
}).join('\n')
const sql = `BEGIN;
${imports}
\\i tests/db/rules-support.sql
CREATE TEMP TABLE audit_result (result jsonb);
DO $$
DECLARE f record; original record; other uuid; a uuid; b uuid; spare uuid; items jsonb; teams jsonb; actual jsonb; active_count int;
BEGIN
  SELECT m.*,r.league_season_id,l.roster_size,l.ir_slots,l.taxi_slots,l.allow_inactive_trades,l.taxi_max_seasons
    INTO STRICT original FROM audit_league_members m JOIN audit_roster_players r ON r.member_id=m.id AND r.is_on_ir
    JOIN audit_leagues l ON l.id=m.league_id JOIN audit_league_seasons s ON s.id=r.league_season_id AND s.is_current
    WHERE EXISTS(SELECT 1 FROM audit_roster_players x WHERE x.member_id=m.id AND x.league_season_id=s.id AND NOT x.is_on_ir AND NOT x.is_on_taxi)
    ORDER BY (m.team_name ILIKE '%justin%') DESC,m.id LIMIT 1;
  SELECT member_id INTO STRICT other FROM audit_roster_players WHERE league_season_id=original.league_season_id
    AND member_id<>original.id AND NOT is_on_ir AND NOT is_on_taxi LIMIT 1;
  SELECT * INTO f FROM pg_temp.rules_fixture(2,2026);
  UPDATE leagues SET roster_size=original.roster_size,ir_slots=original.ir_slots,taxi_slots=original.taxi_slots,
    allow_inactive_trades=original.allow_inactive_trades,taxi_max_seasons=original.taxi_max_seasons WHERE id=f.league_id;
  UPDATE league_members SET team_name=CASE WHEN id=f.member_ids[1] THEN original.team_name ELSE 'Other manager' END WHERE league_id=f.league_id;
  INSERT INTO players(id,first_name,last_name,position,eligible_positions,injury_status,years_exp,career_regular_season_games) SELECT p.id,p.first_name,p.last_name,p.position,p.eligible_positions,p.injury_status,p.years_exp,p.career_regular_season_games FROM audit_players p WHERE EXISTS(SELECT 1 FROM audit_roster_players r
    WHERE r.league_season_id=original.league_season_id AND r.member_id IN(original.id,other) AND r.player_id=p.id)
    ON CONFLICT(id) DO NOTHING;
  ALTER TABLE roster_players DISABLE TRIGGER USER;
  INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir,is_on_taxi,taxi_start_season_year)
    SELECT f.league_id,f.season_id,CASE WHEN member_id=original.id THEN f.member_ids[1] ELSE f.member_ids[2] END,
      player_id,'draft',is_on_ir,is_on_taxi,taxi_start_season_year FROM audit_roster_players
      WHERE league_season_id=original.league_season_id AND member_id IN(original.id,other);
  ALTER TABLE roster_players ENABLE TRIGGER USER;
  SELECT player_id INTO a FROM roster_players WHERE member_id=f.member_ids[1] AND is_on_ir LIMIT 1;
  SELECT player_id INTO b FROM roster_players WHERE member_id=f.member_ids[2] AND NOT is_on_ir AND NOT is_on_taxi LIMIT 1;
  SELECT player_id INTO spare FROM roster_players WHERE member_id=f.member_ids[1] AND NOT is_on_ir AND NOT is_on_taxi LIMIT 1;
  items:=jsonb_build_array(jsonb_build_object('playerId',a,'fromMemberId',f.member_ids[1],'toMemberId',f.member_ids[2]),
    jsonb_build_object('playerId',b,'fromMemberId',f.member_ids[2],'toMemberId',f.member_ids[1]));
  actual:=public.preview_trade_legality(f.user_ids[1],f.league_id,f.member_ids,items,'{}');
  SELECT count(*) INTO active_count FROM roster_players WHERE member_id=f.member_ids[1] AND NOT is_on_ir AND NOT is_on_taxi;
  UPDATE leagues SET roster_size=active_count,allow_inactive_trades=true,taxi_max_seasons=NULL WHERE id=f.league_id;
  UPDATE players SET injury_status='Out' WHERE id IN(SELECT player_id FROM roster_players WHERE league_id=f.league_id AND is_on_ir);
  UPDATE players SET years_exp=0,career_regular_season_games=0 WHERE id IN(SELECT player_id FROM roster_players WHERE league_id=f.league_id AND is_on_taxi);
  teams:=public.preview_trade_legality(f.user_ids[1],f.league_id,f.member_ids,items,'{}');
  PERFORM pg_temp.check_rules(teams->0->'reasons' @> '[{"rule":"active_slots"}]','production-shaped IR swap exceeds Regular capacity');
  PERFORM pg_temp.check_rules(teams->0->>'error' LIKE '%from IR does not free a Regular slot%','production-shaped message names IR and the fix');
  INSERT INTO audit_result VALUES(jsonb_build_object('originalTeam',original.team_name,'originalActive',active_count,'originalLimit',original.roster_size,
    'actualReasons',actual->0->'reasons','fullRosterReasons',teams->0->'reasons'));
  teams:=public.preview_trade_legality(f.user_ids[1],f.league_id,f.member_ids,items,
    jsonb_build_object(f.member_ids[1]::text,jsonb_build_object('dropPlayerIds',jsonb_build_array(spare))));
  PERFORM pg_temp.check_rules((teams->0->>'legal')::boolean,'a concrete retained-player drop fixes the production-shaped sender');
END;
$$;
SELECT result FROM audit_result;
ROLLBACK;
`
const result = execFileSync('psql', [database, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
process.stdout.write(result)
