#!/bin/zsh
set -u
cd /Users/michaelchen/Projects/Apps/pancake
S=/private/tmp/claude-501/-Users-michaelchen-Projects-Apps-pancake/d0fb02a5-fe4b-4066-8a8d-f3caf50ed823/scratchpad/local
R=$S/p11
log() { echo "$(date -u +%FT%TZ) $*" | tee -a $R/progress.txt; }
fail() { log "SETUP FAILED: $*"; echo "setup-failed" > $R/outcome.txt; exit 90; }
source $S/local.sh
for v in "$EXPO_PUBLIC_SUPABASE_URL" "$E2E_API_BASE_URL" "$E2E_FRONTEND_URL" "$SUPABASE_DB_URL" "$E2E_SUPABASE_URL"; do
  case "$v" in *127.0.0.1*|*localhost*) ;; *) fail "non-loopback endpoint";; esac
  case "$v" in *supabase.co*) fail "production URL present";; esac
done
log "loopback asserted for all E2E endpoints"
EXE="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"
test -x "$EXE" || fail "executable missing"
{ echo "commit $(git rev-parse HEAD)"; echo "agent-browser $(agent-browser --version 2>&1 | head -1)"; echo "executable $EXE"; echo "executable --version: $("$EXE" --version 2>&1 | head -1)"; echo "node $(node --version)"; echo "supabase $(supabase --version 2>&1 | head -1)"; } > $R/conditions.txt
{ echo "# power/display at start $(date -u +%FT%TZ)"; pmset -g batt | head -2; pmset -g assertions | grep -E 'PreventUserIdleDisplaySleep|PreventUserIdleSystemSleep|PreventSystemSleep|InternalPreventDisplaySleep' | head -6; ioreg -n IODisplayWrangler -r -d 1 2>/dev/null | grep -o '"CurrentPowerState"=[0-9]*\|"DevicePowerState"=[0-9]*' | head -2; } >> $R/conditions.txt
# scoped caffeinate: display + idle sleep prevented only while this script runs
caffeinate -d -i -w $$ &
CAF=$!; log "caffeinate -d -i scoped to this script (pid $CAF)"
supabase start > $R/supabase-start.log 2>&1 || fail "supabase start"
copy=$(mktemp -d "${TMPDIR:-/tmp}/pancake-midlife-base.XXXXXX") || fail mktemp
rsync -a --exclude .branches --exclude .temp supabase/ "$copy/supabase/" || fail rsync
base=20260823000001
plan=$(node tests/e2e/release-soak-migration-plan.mjs "$base" $(ls supabase/migrations)) || fail plan
echo "$plan" > $R/plan.json
for f in $(node -e 'for (const v of JSON.parse(process.argv[1]).pendingFiles) console.log(v)' "$plan"); do rm "$copy/supabase/migrations/$f" || fail "rm $f"; done
test "$(ls "$copy/supabase/migrations" | wc -l | tr -d ' ')" = 304 || fail "base copy count"
test "$(ls supabase/migrations | wc -l | tr -d ' ')" = 307 || fail "repo migrations count changed"
(cd "$copy" && supabase db reset > $R/db-reset-base.log 2>&1) || fail "db reset from base copy"
head=$(psql "$SUPABASE_DB_URL" -tAc 'select max(version) from supabase_migrations.schema_migrations')
cnt=$(psql "$SUPABASE_DB_URL" -tAc 'select count(*) from supabase_migrations.schema_migrations')
echo "after base reset: count=$cnt head=$head" | tee $R/schema-before.txt
test "$head" = "$base" || fail "head $head != $base"
test "$cnt" = 304 || fail "count $cnt != 304"
log "database on base schema (304, head $base); repo migrations untouched (307)"
supabase functions serve --env-file $S/functions-fake.env > $R/functions.log 2>&1 &
echo $! > $R/functions.pid
npm run build:web:release > $R/export.log 2>&1 || fail "release build"
grep -c . $R/export.log > /dev/null
npm run e2e:seed > $R/seed.log 2>&1 || fail "seed"
node tests/e2e/static-web-server.mjs > $R/static.log 2>&1 &
echo $! > $R/static.pid
ok=0; for i in $(seq 1 20); do curl -sf -o /dev/null "$E2E_FRONTEND_URL/" && curl -sf -o /dev/null "$E2E_API_BASE_URL/health" && ok=1 && break; sleep 3; done
test $ok = 1 || fail "frontend/api health"
log "stack ready: functions (fake upstream env), stamped release build served, seeded"
export E2E_ENABLE_MIDLIFE_MIGRATION=1 E2E_MIDLIFE_MIGRATION_AFTER_SEASON=5
export E2E_MIDLIFE_EXPECTED_BASE_VERSION="$base"
export E2E_MIDLIFE_EXPECTED_VERSION=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).repositoryHead)' "$plan")
export E2E_MIDLIFE_EXPECTED_VERSIONS=$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).pendingVersions))' "$plan")
export AGENT_BROWSER_EXECUTABLE_PATH="$EXE"
env | grep -E '^E2E_(ENABLE_MIDLIFE|MIDLIFE)|^AGENT_BROWSER_EXECUTABLE_PATH' > $R/release-env.txt
date -u +%FT%TZ > $R/release-start.txt
log "release soak started: timeout -s TERM 36000 npm run e2e:soak:release"
timeout -s TERM 36000 npm run e2e:soak:release > $R/release.log 2>&1
rc=$?
echo "$rc" > $R/release-exit.txt
date -u +%FT%TZ > $R/release-end.txt
if [ $rc = 124 ]; then echo "timeout wrapper: BOUND HIT (124); child killed by SIGTERM" > $R/release-exit-meaning.txt; else echo "timeout wrapper passed through the child's exit: $rc (npm returns node's status)" > $R/release-exit-meaning.txt; fi
log "release soak finished rc=$rc ($(cat $R/release-exit-meaning.txt))"
psql "$SUPABASE_DB_URL" -tAc 'select count(*), max(version) from supabase_migrations.schema_migrations' > $R/schema-after.txt
{ echo "# power/display at end $(date -u +%FT%TZ)"; pmset -g batt | head -2; ioreg -n IODisplayWrangler -r -d 1 2>/dev/null | grep -o '"CurrentPowerState"=[0-9]*\|"DevicePowerState"=[0-9]*' | head -2; } >> $R/conditions.txt
cp -R tests/artifacts $R/artifacts 2>/dev/null
kill $(cat $R/functions.pid) $(cat $R/static.pid) 2>/dev/null; sleep 2; pkill -f 'supabase functions serve' 2>/dev/null
supabase stop > $R/supabase-stop.log 2>&1; echo "stop exit $?" >> $R/supabase-stop.log
echo "done" > $R/outcome.txt
log "stack stopped"
