#!/bin/sh
set -u
FAIL=0
PSQL="psql ${SUPABASE_DB_URL:?SUPABASE_DB_URL is required} -X"
IDS=$($PSQL -qAt -f tests/db/r3-case-5-setup.sql 2>&1 | grep 'IDS ' | sed 's/.*IDS //')
IDS1=$(echo "$IDS" | sed -n 1p)
IDS2=$(echo "$IDS" | sed -n 2p)
LEAGUE=$(echo "$IDS1" | cut -d'|' -f1)
SEASON=$(echo "$IDS1" | cut -d'|' -f2)
MEMBER=$(echo "$IDS1" | cut -d'|' -f3)
OCCUPANT=$(echo "$IDS1" | cut -d'|' -f4)
LEAGUE2=$(echo "$IDS2" | cut -d'|' -f1)
SEASON2=$(echo "$IDS2" | cut -d'|' -f2)
MEMBER2=$(echo "$IDS2" | cut -d'|' -f3)
OCCUPANT2=$(echo "$IDS2" | cut -d'|' -f4)
$PSQL -qAt -c "BEGIN; SELECT pg_advisory_xact_lock(hashtext('$LEAGUE'), hashtext('$MEMBER')); SELECT pg_sleep(10); COMMIT;" >/dev/null 2>&1 &
LOCK_PID=$!
sleep 1
$PSQL -qAt -c "SELECT public.auto_manage_ir_service('$LEAGUE', '$SEASON', '$MEMBER');" >/dev/null 2>&1
wait $LOCK_PID
IS_ON_IR=$($PSQL -qAt -c "SELECT is_on_ir FROM public.roster_players WHERE league_id='$LEAGUE' AND member_id='$MEMBER' AND player_id='$OCCUPANT'")
if [ "$IS_ON_IR" = "t" ]; then echo "PASS case-5-ir"; else echo "FAIL case-5-ir"; FAIL=1; fi
$PSQL -qAt -c "BEGIN; SELECT pg_advisory_xact_lock(hashtext('$LEAGUE2'), hashtext('$MEMBER2')); SELECT pg_sleep(10); COMMIT;" >/dev/null 2>&1 &
LOCK2_PID=$!
sleep 1
$PSQL -qAt -c "SELECT private.run_league_roster_floor('$LEAGUE2', '$SEASON2');" >/dev/null 2>&1
wait $LOCK2_PID
IS_ON_IR2=$($PSQL -qAt -c "SELECT is_on_ir FROM public.roster_players WHERE league_id='$LEAGUE2' AND member_id='$MEMBER2' AND player_id='$OCCUPANT2'")
WEEK_STATUS=$($PSQL -qAt -c "SELECT status FROM private.roster_floor_weeks WHERE league_id='$LEAGUE2'")
if [ "$IS_ON_IR2" = "t" ] && [ "$WEEK_STATUS" != "completed" ]; then echo "PASS case-5-floor"; else echo "FAIL case-5-floor"; FAIL=1; fi
$PSQL -qAt -c "DELETE FROM public.leagues WHERE id IN ('$LEAGUE','$LEAGUE2');" >/dev/null 2>&1
$PSQL -qAt -c "DELETE FROM public.players WHERE nba_team IN ('ZZ','QQ') AND first_name IN ('Roster','IR');" >/dev/null 2>&1
$PSQL -qAt -c "DELETE FROM public.nba_games WHERE nba_game_id IN ('0029930001','0029931001');" >/dev/null 2>&1
$PSQL -qAt -c "DELETE FROM public.season_weeks WHERE season_year IN (9930,9931);" >/dev/null 2>&1
LEFT=$($PSQL -qAt -c "SELECT count(*) FROM public.leagues WHERE id IN ('$LEAGUE','$LEAGUE2')")
LEFT2=$($PSQL -qAt -c "SELECT count(*) FROM public.players WHERE nba_team IN ('ZZ','QQ') AND first_name IN ('Roster','IR')")
LEFT3=$($PSQL -qAt -c "SELECT count(*) FROM public.nba_games WHERE nba_game_id IN ('0029930001','0029931001')")
LEFT4=$($PSQL -qAt -c "SELECT count(*) FROM public.season_weeks WHERE season_year IN (9930,9931)")
if [ "$LEFT" != "0" ] || [ "$LEFT2" != "0" ] || [ "$LEFT3" != "0" ] || [ "$LEFT4" != "0" ]; then echo "FAIL cleanup"; FAIL=1; fi
exit "$FAIL"
