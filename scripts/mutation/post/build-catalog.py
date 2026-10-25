import json
import re
from pathlib import Path

functions = {}
for file in sorted(Path('supabase/migrations').glob('*.sql')):
    source = file.read_text()
    for match in re.finditer(r'CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)\s*\(', source, re.I):
        tail = source[match.start():]
        body = re.search(r'\bAS\s+(\$\w*\$)', tail, re.I)
        if not body:
            continue
        end = tail.find(body[1], body.end())
        if end < 0:
            continue
        functions[match[1]] = (str(file), source[:match.start()].count('\n') + 1, tail[:end + len(body[1]) + 1])

def oracle(name):
    return {'name': name, 'command': 'psql "$SUPABASE_DB_URL" -Xv ON_ERROR_STOP=1 -f tests/db/' + name + '.sql'}

areas = {
    'playoffs': ['general-playoff-brackets', 'playoff-boundary-guards', 'playoff-seed-corrections', 'playoff-ranking-priority'],
    'champion': ['playoff-boundary-guards', 'playoff-transitions', 'dynasty-rules'],
    'trade-deadline': ['league-season-rules', 'trade-expiry-authorization', 'deadline-locks'],
    'rookie-draft': ['dynasty-rules', 'draft-goal-behavior', 'picks-lifecycle'],
    'picks': ['league-season-rules', 'dynasty-rules', 'draft-goal-behavior', 'picks-lifecycle', 'rollover-year-gap'],
}
catalog = []
def add(area, symbol, signature, original, mutated, operator):
    file, line, definition = functions[symbol]
    assert definition.count(original) == 1, (symbol, original, definition.count(original))
    catalog.append({'id': area + '-' + str(sum(x['area'] == area for x in catalog) + 1).zfill(2), 'area': area, 'file': file, 'line': line + definition[:definition.index(original)].count('\n'), 'symbol': symbol + '(' + signature + ')', 'operator': operator, 'original': original, 'mutated': mutated, 'oracles': list(map(oracle, areas[area]))})

s='private.generate_playoff_round'; sig='uuid,uuid,integer'
add('playoffs',s,sig,'v_order[v_index]<=cardinality(v_seeds)','v_order[v_index]<cardinality(v_seeds)','boundary')
add('playoffs',s,sig,'v_winner:=COALESCE(v_home,v_away);','v_winner:=v_away;','bye-removal')
add('playoffs',s,sig,'SELECT winner_member_id INTO v_winner','SELECT home_member_id INTO v_winner','wrong-winner')
add('playoffs',s,sig,'AND is_finalized AND winner_member_id IS NOT NULL','AND NOT is_finalized AND winner_member_id IS NOT NULL','negate-finalized')
add('playoffs',s,sig,'v_end:=v_start+v_season.playoff_round_weeks[p_round]-1','v_end:=v_start+v_season.playoff_round_weeks[p_round]','off-by-one')
add('playoffs',s,sig,'v_start:=v_season.playoff_start_week+COALESCE','v_start:=v_season.playoff_start_week-COALESCE','arithmetic')
s='private.playoff_seed_rankings'; sig='uuid,uuid,integer'
add('playoffs',s,sig,'ORDER BY wins DESC, points_for DESC','ORDER BY wins ASC, points_for DESC','ordering-flip')
add('playoffs',s,sig,'points_for DESC, max_possible_points DESC','points_for ASC, max_possible_points DESC','ordering-flip')
add('playoffs',s,sig,'max_possible_points DESC, points_against ASC','max_possible_points ASC, points_against ASC','ordering-flip')
add('playoffs',s,sig,'points_against ASC, tie_token ASC','points_against DESC, tie_token ASC','ordering-flip')
s='public.apply_season_boundary_after_grace'; sig='uuid,uuid,text,timestamp with time zone'
add('champion',s,sig,"v_latest > p_reference_at - interval '48 hours'","v_latest > p_reference_at - interval '24 hours'",'grace-shortened')
add('champion',s,sig,'is_finalized IS TRUE AND (v_type','is_finalized IS NOT TRUE AND (v_type','negate-finalized')
add('champion',s,sig,"v_type = 'regular_season' OR winner_member_id IS NOT NULL","v_type = 'regular_season' OR winner_member_id IS NULL",'winner-null')
add('champion',s,sig,"v_type := 'playoff_final';","v_type := 'regular_season';",'wrong-prerequisite')
add('champion',s,sig,'season.league_id = p_league_id AND season.is_current','season.league_id = p_league_id AND NOT season.is_current','negate-current')
add('champion',s,sig,'v_count = 0 OR v_ready IS DISTINCT FROM true','v_count = 0 AND v_ready IS DISTINCT FROM true','logical')
s='public.advance_season_atomic'; sig='uuid'
add('champion',s,sig,"SET status = 'offseason',","SET status = 'active',",'wrong-transition')
add('champion',s,sig,'SET is_current = false','SET is_current = true','history-current')
add('champion',s,sig,'v_current_season.season_year + 1','v_current_season.season_year + 2','off-by-one')
add('champion',s,sig,"v_league.status NOT IN ('playoffs'::league_status, 'archived'::league_status)","v_league.status IN ('playoffs'::league_status, 'archived'::league_status)",'negate-status-gate')
s='private.trade_deadline_for_season'; sig='date,integer'
add('trade-deadline',s,sig,'extract(month FROM p_deadline) >= 10','extract(month FROM p_deadline) > 10','boundary')
add('trade-deadline',s,sig,'p_season_year - 1','p_season_year + 1','year-arithmetic')
add('trade-deadline',s,sig,'+ least(','+ greatest(','leap-clamp')
add('trade-deadline',s,sig,'    - 1\n','    - 0\n','day-offset')
s='public.prevent_trade_acceptance_after_deadline'; sig=''
add('trade-deadline',s,sig,"v_trade_deadline < (now() AT TIME ZONE 'America/New_York')::date","v_trade_deadline <= (now() AT TIME ZONE 'America/New_York')::date",'inclusive-boundary')
add('trade-deadline',s,sig,"v_league_status = 'active'::league_status","v_league_status = 'setup'::league_status",'wrong-status')
add('trade-deadline',s,sig,'AND NOT v_champion_finalized','AND v_champion_finalized','champion-reopening')
s='private.create_trade_offer'; sig='uuid,uuid,uuid,uuid,uuid[],uuid[],uuid[],uuid[],text,timestamp with time zone,integer,integer,uuid,uuid,uuid,integer'
add('trade-deadline',s,sig,"v_league.trade_deadline < (now() AT TIME ZONE 'America/New_York')::date","v_league.trade_deadline <= (now() AT TIME ZONE 'America/New_York')::date",'inclusive-boundary')
add('trade-deadline',s,sig,"(p_expires_at AT TIME ZONE 'America/New_York')::date > v_league.trade_deadline","(p_expires_at AT TIME ZONE 'America/New_York')::date < v_league.trade_deadline",'expiry-comparison')
s='public.expire_pending_trades_atomic'; sig='integer'
add('trade-deadline',s,sig,'pending.expires_at <= now()','pending.expires_at > now()','expiry-comparison')
s='public.start_rookie_draft_atomic'; sig='uuid,integer,boolean,integer,text'
add('rookie-draft',s,sig,'wins ASC,','wins DESC,','reverse-standings')
add('rookie-draft',s,sig,'points_for ASC,','points_for DESC,','tiebreak-order')
add('rookie-draft',s,sig,'ORDER BY season_year DESC','ORDER BY season_year ASC','season-selection')
add('rookie-draft',s,sig,'has_standings DESC,','has_standings ASC,','new-member-order')
add('rookie-draft',s,sig,'p_rounds < 1 OR p_rounds > 3','p_rounds < 1 OR p_rounds > 2','round-limit')
add('rookie-draft',s,sig,'dp.current_owner_id AS member_id','pick_slots.original_owner_id AS member_id','traded-slot-owner')
add('rookie-draft',s,sig,"SET status = 'drafting'","SET status = 'offseason'",'draft-state')
s='public.auto_pick_snake_pick_atomic'; sig='uuid,uuid,text,boolean'
add('rookie-draft',s,sig,'ORDER BY player.nba_draft_number, player.id','ORDER BY player.nba_draft_number DESC, player.id','autopick-choice')
s='private.make_snake_pick_atomic_internal'; sig='uuid,uuid,uuid,boolean,boolean'
add('rookie-draft',s,sig,'IF v_remaining = 0 THEN','IF v_remaining > 0 THEN','completion-gate')
add('rookie-draft',s,sig,'AND round = v_next_pick.round','AND round <> v_next_pick.round','asset-round')
s='public.create_league'; sig='text,text,integer'
add('picks',s,sig,'generate_series(v_season_year + 1, v_season_year + 5)','generate_series(v_season_year + 2, v_season_year + 5)','allocation-start')
add('picks',s,sig,'generate_series(1, 3) AS round_value','generate_series(1, 2) AS round_value','allocation-rounds')
s='public.advance_season_atomic'; sig='uuid'
add('picks',s,sig,'v_far_year := v_new_year + 5','v_far_year := v_new_year + 4','allocation-horizon')
add('picks',s,sig,'unnest(ARRAY[1, 2, 3]) AS round_value','unnest(ARRAY[1, 2]) AS round_value','rollover-rounds')
s='private.sync_snake_slot_pick_owner'; sig=''
add('picks',s,sig,'SET member_id = NEW.current_owner_id','SET member_id = OLD.current_owner_id','owner-transfer')
add('picks',s,sig,'AND player_id IS NULL','AND player_id IS NOT NULL','filled-slot-filter')
s='public.start_rookie_draft_atomic'; sig='uuid,integer,boolean,integer,text'
add('picks',s,sig,'AND original_owner_id = pick_slots.original_owner_id','AND current_owner_id = pick_slots.original_owner_id','original-owner-lookup')
s='public.complete_accepted_trade_atomic'; sig='uuid'
add('picks',s,sig,'SET current_owner_id = v_to_member','SET current_owner_id = v_from_member','trade-transfer')
s='private.make_snake_pick_atomic_internal'; sig='uuid,uuid,uuid,boolean,boolean'
add('picks',s,sig,'SET is_used = true,','SET is_used = false,','pick-consumption')
s='public.start_rookie_draft_atomic'; sig='uuid,integer,boolean,integer,text'
add('picks',s,sig,'((round - 1) * v_order_count) + pick_in_round,\n      round,\n      pick_in_round,\n      member_id,\n      draft_pick_id','((round - 1) * v_order_count) + (v_order_count-pick_in_round+1),\n      round,\n      pick_in_round,\n      member_id,\n      draft_pick_id','snake-reversal')
def add_ts(original, mutated, operator):
    file = 'supabase/functions/_shared/seasonBoundary.ts'
    source = Path(file).read_text()
    assert source.count(original) == 1
    number = sum(x['area'] == 'rookie-draft' for x in catalog) + 1
    catalog.append({'id': f'rookie-draft-{number:02}', 'area': 'rookie-draft', 'file': file, 'line': source[:source.index(original)].count('\n')+1, 'symbol': 'runSeasonBoundary', 'operator': operator, 'original': original, 'mutated': mutated, 'oracles': [{'name': 'rookie-backstop', 'command': 'deno run --no-lock --check --allow-env --allow-net=127.0.0.1,localhost --allow-read --allow-run=psql supabase/tests/db/rookie-backstop.ts'}]})

add_ts("['active', 'playoffs', 'offseason', 'drafting']", "['active', 'playoffs', 'offseason']", 'drafting-query-exclusion')
add_ts("['in_progress', 'paused'].includes(draft.status)", "['in_progress'].includes(draft.status)", 'paused-exclusion')
add_ts('toETDate(referenceDate) < firstEligibleWeek.week_start', 'toETDate(referenceDate) <= firstEligibleWeek.week_start', 'ET-day-boundary')
add_ts('const MAX_BACKSTOP_PICKS = 200', 'const MAX_BACKSTOP_PICKS = 1', 'pick-limit')
add_ts("p_reason: 'season_boundary_backstop'", "p_reason: 'manual'", 'expired-timer-authorization')
add('rookie-draft','public.auto_pick_snake_pick_atomic','uuid,uuid,text,boolean',"v_draft.status = 'paused'", "v_draft.status = 'in_progress'", 'resume-status')
catalog[-1]['oracles'] = catalog[-2]['oracles']
add('picks','public.advance_season_atomic','uuid','generate_series(v_new_year,v_far_year)','generate_series(v_new_year+1,v_far_year)','fill-start-boundary')
catalog[-1]['oracles'] = [oracle('rollover-year-gap')]
add('picks','public.advance_season_atomic','uuid','ON CONFLICT (league_id, season_year, round, original_owner_id) DO NOTHING','ON CONFLICT (league_id, season_year, round, original_owner_id) DO UPDATE SET current_owner_id=EXCLUDED.current_owner_id','fill-owner-preservation')
catalog[-1]['oracles'] = [oracle('rollover-year-gap')]
add('rookie-draft','public.invoke_season_boundary_if_due','timestamp with time zone',"'drafting'::public.league_status", "'setup'::public.league_status", 'drafting-cron-gate')
catalog[-1]['oracles'] = [oracle('rookie-drafting-gate')]
add_ts("status !== 'offseason' && status !== 'drafting'", "status !== 'offseason' && status !== 'setup'", 'drafting-job-filter')
add('rookie-draft','public.auto_pick_snake_pick_atomic','uuid,uuid,text,boolean',"AND NOT v_draft.is_mock AND v_draft.status = 'paused'", "AND v_draft.status = 'paused'", 'mock-resume-guard')
catalog[-1]['oracles'] = catalog[-2]['oracles']
add_ts('runRookieDraftBackstop(season.league_id, season.id, referenceDate, false)', 'runRookieDraftBackstop(season.league_id, season.id, referenceDate, true)', 'startup-auction-guard')
add_ts('toETDate(referenceDate) < firstEligibleWeek.week_start', 'toETDate(referenceDate) > firstEligibleWeek.week_start', 'premature-commissioner-resume')
catalog[-1]['oracles'] = [{'name': 'rookie-commissioner-early', 'command': 'POST_ROOKIE_CASE=commissioner_early deno run --no-lock --check --allow-env --allow-net=127.0.0.1,localhost --allow-read --allow-run=psql supabase/tests/db/rookie-backstop.ts'}]
add('rookie-draft','public.invoke_season_boundary_if_due','timestamp with time zone',"IF NOT private.claim_cron_dispatch('season-boundary', to_char(v_now, 'YYYY-MM-DD')) THEN\n    RETURN;\n  END IF;", "PERFORM private.claim_cron_dispatch('season-boundary', to_char(v_now, 'YYYY-MM-DD'));", 'daily-dispatch-guard')
catalog[-1]['oracles'] = [oracle('rookie-drafting-gate')]
skip_oracle = {'name': 'rookie-skipped-week', 'command': 'deno run --no-lock --check --allow-env --allow-net=127.0.0.1,localhost --allow-read --allow-run=psql supabase/tests/db/rookie-skipped-week.ts'}
areas['skipped-week'] = []
def add_skip(symbol, signature, original, mutated, operator):
    add('skipped-week', symbol, signature, original, mutated, operator)
    catalog[-1]['id'] = f"post-sw-{sum(x['area'] == 'skipped-week' for x in catalog):02}"
    catalog[-1]['oracles'] = [skip_oracle]

def add_skip_ts(original, mutated, operator):
    add_ts(original, mutated, operator)
    catalog[-1]['area'] = 'skipped-week'
    catalog[-1]['id'] = f"post-sw-{sum(x['area'] == 'skipped-week' for x in catalog):02}"
    catalog[-1]['oracles'] = [skip_oracle]

add_skip('private.regular_season_matchup_payload','uuid,uuid,integer','AND v_week=ANY(skipped_weeks)','AND NOT v_week=ANY(skipped_weeks)','NEG')
add_skip('private.regular_season_matchup_payload','uuid,uuid,integer','v_played := v_played + 1;','','STMT-DEL')
add_skip('private.enforce_skipped_matchup','','NEW.is_voided := true;','NEW.is_voided := false;','CONST')
add_skip('private.enforce_skipped_matchup','','NEW.winner_member_id := NULL;','','STMT-DEL')
add_skip('public.update_league_settings_atomic','uuid,jsonb','week>=COALESCE(v_playoff_start_week,v_league.playoff_start_week)','week>COALESCE(v_playoff_start_week,v_league.playoff_start_week)','ROR')
add_skip('public.update_league_settings_atomic','uuid,jsonb','UPDATE public.matchups SET is_voided=true WHERE league_season_id=v_current.id AND week_number=ANY(v_skip);','','STMT-DEL')
add_skip('private.generate_playoff_round','uuid,uuid,integer','v_start:=v_season.playoff_start_week+COALESCE','v_start:=v_season.playoff_start_week+1+COALESCE','CONST')
add_skip_ts('!season.skipped_weeks.includes(week.week_number)','season.skipped_weeks.includes(week.week_number)','NEG')
add_skip_ts('toETDate(referenceDate) < firstEligibleWeek.week_start','toETDate(referenceDate) <= firstEligibleWeek.week_start','ROR')
add_skip_ts('.order(\'week_number\')', '.order(\'week_number\', { ascending: false })', 'ORDER')
stale_oracle = {'name': 'playoff-stale-boundary', 'command': 'deno run --no-lock --check --allow-env --allow-net=127.0.0.1,localhost --allow-read --allow-run=psql supabase/tests/db/playoff-stale-boundary.ts'}
def add_stale(original, mutated, operator, symbol='applyBoundaryWithScoreRefresh'):
    add_ts(original, mutated, operator)
    catalog[-1].update(id=f'post-stale-{sum(x["id"].startswith("post-stale-") for x in catalog)+1:02}', area='champion', symbol=symbol, oracles=[stale_oracle])

add_stale('if (stale.length === 0) return result','if (stale.length >= 0) return result','ROR')
add_stale('if (!finalDecided || !graceElapsed(finals, referenceDate)) return actions','if (!finalDecided) return actions','STMT-DEL','processLeagueBoundary')
add_stale('const refreshed = await applyBoundaryAfterGrace(leagueId, seasonId, action, referenceDate)','const refreshed = result','STMT-DEL')
add_stale('(await staleBoundaryWeeks(seasonId, weeks)).length > 0','(await staleBoundaryWeeks(seasonId, weeks)).length < 0','ROR')
add_stale('await syncScores(leagueId, referenceDate, { recoverStats: false })','await syncScores(leagueId, referenceDate, { recoverStats: true })','CONST')
Path('scripts/mutation/post/catalog.json').write_text(json.dumps(catalog, indent=2) + '\n')
print(len(catalog), 'mutants')
