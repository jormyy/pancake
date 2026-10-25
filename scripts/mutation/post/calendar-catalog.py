import json
from pathlib import Path

root = Path(__file__).resolve().parents[3]
path = root / 'scripts/mutation/post/catalog.json'
catalog = [row for row in json.loads(path.read_text()) if not row['id'].startswith('post-t3-')]
schedule = 'supabase/functions/_shared/schedule.ts'
nba = 'supabase/functions/_shared/nba.ts'
sql = 'supabase/migrations/20261020000062_calendar_ingestion_contracts.sql'

def add(area, file, symbol, operator, original, mutated, test, case):
    contents = (root / file).read_text()
    assert contents.count(original) == 1, (original, contents.count(original))
    command = f'POST_CALENDAR_CASE={case} node scripts/mutation/post/check.mjs {test}'
    catalog.append(dict(id=f'post-t3-{len([r for r in catalog if r["id"].startswith("post-t3-")])+1:02}', area=area,
        file=file, line=contents[:contents.index(original)].count('\n')+1, symbol=symbol, operator=operator,
        original=original, mutated=mutated, oracles=[dict(name='calendar-'+case, command=command, timeout=120000)]))

def ts(area, operator, original, mutated, case):
    add(area, schedule, 'buildScheduleSyncPlan', operator, original, mutated, 'supabase/tests/db/calendar-seasons.ts', case)

ts('opening-night','ORDER','regularSeason.map((game) => game.gameDate).sort()[0] ?? null','regularSeason.map((game) => game.gameDate).sort().at(-1) ?? null','opening')
ts('opening-night','CONST','return month >= 10 ? year + 1 : year','return month >= 11 ? year + 1 : year','opening')
ts('opening-night','CONST','getUTCDay() + 6) % 7','getUTCDay() + 5) % 7','opening')
ts('opening-night','CONST','Math.floor((ordinal(date) - monday) / 7) + 1','Math.floor((ordinal(date) - monday) / 7) + 2','opening')
ts('all-star-week','CONST','ordinal(date) - ordinal(ordered[index]) >= 5','ordinal(date) - ordinal(ordered[index]) >= 2','all-star')
ts('all-star-week','CONST','nbaWeek(date) === nbaWeek(ordered[index]) + 1','nbaWeek(date) === nbaWeek(ordered[index]) + 2','all-star')
ts('all-star-week','ROR','nbaWeek(game_date) >= postBreakWeek','nbaWeek(game_date) > postBreakWeek','all-star')
ts('all-star-week','CONST','nbaWeek(game_date) >= postBreakWeek ? 1 : 0','nbaWeek(game_date) >= postBreakWeek ? 0 : 0','all-star')
add('all-star-week',sql,'public.publish_nba_schedule_atomic(integer,jsonb,jsonb)','STMT-DEL',"IF v_complete THEN p_weeks:='[]'::jsonb; END IF;",'IF v_complete THEN NULL; END IF;','supabase/tests/db/calendar-publish.ts','published')
ts('nba-cup','NEG','raw.filter((game) => isRegularSeasonGameId(game.gameId))','raw.filter((game) => !isRegularSeasonGameId(game.gameId))','cup')
add('postponement',nba,'parseNBAScheduleGame','CONST',"['Y', '1', 'true', 'PPD']","['1', 'true', 'PPD']",'supabase/tests/db/calendar-seasons.ts','postponed-status')
add('postponement',sql,'public.publish_nba_schedule_atomic(integer,jsonb,jsonb)','ARG-SWAP','WHEN NOT private.lineup_game_available(stored.status,stored.game_status_text) THEN stored.game_status_text','WHEN NOT private.lineup_game_available(stored.status,stored.game_status_text) THEN EXCLUDED.game_status_text','supabase/tests/db/calendar-ingestion.ts','durable')
add('postponement',sql,'public.publish_nba_schedule_atomic(integer,jsonb,jsonb)','ROR',"stored.status<>'Final'","stored.status='Final'",'supabase/tests/db/calendar-publish.ts','missing')
add('postponement',sql,'public.publish_nba_schedule_atomic(integer,jsonb,jsonb)','ROR','EXCLUDED.game_date IS DISTINCT FROM stored.game_date','EXCLUDED.game_date IS NOT DISTINCT FROM stored.game_date','supabase/tests/db/calendar-ingestion.ts','outside')
for operator, original, mutated in [
    ('NEG', 'if (!allFinalized(regular)) {', 'if (allFinalized(regular)) {'),
    ('ROR', 'toETDate(referenceDate) <= lastWeek.week_end', 'toETDate(referenceDate) >= lastWeek.week_end'),
]:
    add('postponement', 'supabase/functions/_shared/seasonBoundary.ts', 'processLeagueBoundary', operator, original, mutated,
        'supabase/tests/db/playoff-stale-boundary.ts', 'unused')
    catalog[-1]['oracles'] = [dict(name='boundary-unavailable-recheck', command='POST_STALE_CASE=bracket_unavailable_recheck node scripts/mutation/post/check.mjs supabase/tests/db/playoff-stale-boundary.ts', timeout=120000)]
ts('postponement','STMT-DEL','schedule_complete: complete && completeSnapshot','schedule_complete: complete','all-star')
path.write_text(json.dumps(catalog,indent=2)+'\n')
print(f'{len(catalog)} mutants; 17 new ingestion/calendar decisions')
