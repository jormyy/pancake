import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
rows = []


def add(area, symbol, original, mutated, operator, note, occurrence=0):
    schema, name = symbol.split('.')
    canonical = f'supabase/sql/functions/by-name/{schema}/{name}.sql'
    source = (ROOT / canonical).read_text()
    source = source[source.index('CREATE OR REPLACE FUNCTION'):].strip()
    assert source.count(original) > occurrence, (symbol, original)
    latest = None
    for path in sorted((ROOT / 'supabase/migrations').glob('*.sql')):
        offset = path.read_text().find(source)
        if offset >= 0:
            latest = path, offset
    assert latest, symbol
    path, offset = latest
    at = [m.start() for m in re.finditer(re.escape(original), source)][occurrence]
    rows.append(dict(id=f'waiv-{area}-{sum(r["area"] == area for r in rows)+1:02}', area=area,
                     file=str(path.relative_to(ROOT)), line=path.read_text()[:offset+at].count('\n')+1,
                     symbol=symbol, operator=operator, original=original, mutated=mutated,
                     canonical=canonical, occurrence=occurrence, notes=note))


p = 'public.process_next_waiver_claim_atomic'
c = 'public.create_waiver_claim_atomic'
r = 'public.reorder_waiver_claim_atomic'
add('faab', c, 'IF v_bid_amount > v_balance THEN', 'IF v_bid_amount >= v_balance THEN', 'ROR > -> >=', 'Reject an exact-balance bid')
add('faab', c, 'IF v_bid_amount < 0 THEN', 'IF v_bid_amount <= 0 THEN', 'ROR < -> <=', 'Reject a zero bid')
add('faab', p, "wc.bid_amount END DESC NULLS LAST", "wc.bid_amount END ASC NULLS LAST", 'ORDER DESC -> ASC', 'Lowest bid wins')
add('faab', p, 'IF v_faab_balance < v_claim.bid_amount THEN', 'IF v_faab_balance <= v_claim.bid_amount THEN', 'ROR < -> <=', 'Exact balance fails at processing')
add('faab', p, 'balance_row.balance - v_claim.bid_amount', 'balance_row.balance + v_claim.bid_amount', 'AOR - -> +', 'Winning bid credits balance')
add('faab', p, 'IF v_faab_balance < v_claim.bid_amount THEN', 'IF false THEN', 'CONST condition -> false', 'Skip processing balance check')
add('faab', 'private.ensure_faab_balance', 'COALESCE(v_starting_budget, 100)', 'COALESCE(v_starting_budget, 100) + 1', 'CONST budget -> budget+1', 'Wrong lazy seed')
add('faab', 'private.ensure_faab_balance', 'IF FOUND THEN\n    RETURN v_balance;', 'IF FOUND THEN\n    RETURN v_balance + 1;', 'CONST balance -> balance+1', 'Overstate existing available balance')
add('faab', 'private.seed_faab_balances_for_season', 'league.faab_starting_budget\n', 'league.faab_starting_budget + 1\n', 'CONST budget -> budget+1', 'Wrong season seed')
add('faab', 'private.seed_faab_balances_for_member', 'league.faab_starting_budget\n', 'league.faab_starting_budget + 1\n', 'CONST budget -> budget+1', 'Wrong new-member seed')
add('faab', 'private.ensure_season_faab_balances', 'DO NOTHING;', 'DO UPDATE SET balance = EXCLUDED.balance;', 'STMT-REPLACE no-op -> reset balance', 'Repeated ensure replenishes spent FAAB')
add('faab', 'public.commissioner_adjust_faab_balance_atomic', 'SET balance = EXCLUDED.balance,', 'SET balance = faab_balances.balance + EXCLUDED.balance,', 'AOR assignment -> addition', 'Adjustment incorrectly adds instead of sets')
add('waiver-order', p, 'wp.priority ASC,', 'wp.priority DESC,', 'ORDER ASC -> DESC', 'Reverse waiver tiebreak priority')
add('waiver-order', p, 'wc.claim_order ASC,', 'wc.claim_order DESC,', 'ORDER ASC -> DESC', 'Reverse member preferences')
add('waiver-order', p, 'wc.process_date ASC,', 'wc.process_date DESC,', 'ORDER ASC -> DESC', 'Newer due date bypasses older claims')
add('waiver-order', p, 'COALESCE(v_max_priority, 0) + 1', 'COALESCE(v_max_priority, 0) + 0', 'CONST +1 -> +0', 'Winner ties last team')
add('waiver-order', p, 'SELECT max(wp.priority)', 'SELECT min(wp.priority)', 'AGG max -> min', 'Winner does not go last')
add('waiver-order', p, 'AND priority_row.member_id = v_claim.member_id;', 'AND priority_row.member_id <> v_claim.member_id;', 'ROR = -> <>', 'Move losers instead of winner')
add('waiver-order', p, "SET status = 'failed_priority',", "SET status = 'pending',", 'CONST failed_priority -> pending', 'Losing claims remain pending')
add('waiver-order', r, 'AND claim_order < v_claim.claim_order', 'AND claim_order > v_claim.claim_order', 'ROR < -> >', 'Up arrow picks wrong neighbor')
add('waiver-order', r, 'AND claim_order > v_claim.claim_order', 'AND claim_order < v_claim.claim_order', 'ROR > -> <', 'Down arrow picks wrong neighbor')
add('waiver-order', r, 'ORDER BY claim_order, submitted_at, id', 'ORDER BY claim_order DESC, submitted_at, id', 'ORDER ASC -> DESC', 'Reverse normalization')
add('waiver-order', r, 'SET claim_order = v_claim.claim_order', 'SET claim_order = v_other.claim_order', 'ARG-SWAP claim -> other', 'Swap does not update other claim')
add('waiver-order', r, "(v_waiver_mode = 'rolling' OR bid_amount = v_claim.bid_amount)", "(v_waiver_mode = 'faab' OR bid_amount = v_claim.bid_amount)", 'CONST rolling -> faab', 'Normalize unequal FAAB bids as a group')
add('waiver-order', p, 'AND due_wwl.clears_at <= now()', 'AND due_wwl.clears_at < now()', 'ROR <= -> <', 'Exact clears_at boundary is delayed', 0)
add('waiver-limits', 'private.weekly_add_limit_reached', '>= p_limit', '> p_limit', 'ROR >= -> >', 'Allow one add above the limit')
add('waiver-limits', 'private.weekly_add_limit_reached', 'IS NOT NULL AND', 'IS NOT NULL OR', 'LCR AND -> OR', 'Reject below-limit adds')
add('waiver-limits', 'private.weekly_add_limit_reached', 'COALESCE(p_used, 0)', 'COALESCE(p_used, p_limit)', 'CONST zero -> limit', 'Null usage incorrectly exhausts limit')
add('waiver-limits', 'private.consume_weekly_add', 'count_row.add_count + 1', 'count_row.add_count + 0', 'CONST +1 -> +0', 'Never consume an add')
add('waiver-limits', 'private.consume_weekly_add', 'count_row.week_number = v_week', 'count_row.week_number <> v_week', 'ROR = -> <>', 'Consume every other week')
add('waiver-limits', 'private.assert_weekly_add_available', 'IF v_limit IS NULL THEN', 'IF v_limit IS NOT NULL THEN', 'NEGATE IS NULL -> IS NOT NULL', 'Bypass limits and count unlimited leagues')
add('waiver-limits', 'private.assert_weekly_add_available', '    v_week,\n    0', '    v_week,\n    1', 'CONST 0 -> 1', 'Start week with phantom consumption')
add('waiver-limits', 'private.assert_weekly_add_available', 'IF v_message IS NOT NULL THEN', 'IF false THEN', 'CONST condition -> false', 'Never reject exhausted count')
add('waiver-limits', 'public.commissioner_override_weekly_add_count_atomic', 'p_add_count < 0', 'p_add_count <= 0', 'ROR < -> <=', 'Cannot restore all adds')
add('waiver-limits', 'public.commissioner_override_weekly_add_count_atomic', 'SET add_count = EXCLUDED.add_count,', 'SET add_count = weekly_add_counts.add_count + EXCLUDED.add_count,', 'AOR assignment -> addition', 'Override adds instead of sets')
add('waiver-limits', p, 'PERFORM private.assert_weekly_add_available(v_claim.league_id, v_claim.league_season_id, v_claim.member_id);', 'NULL;', 'STMT-DEL processing limit check removed', 'Pending claim bypasses processing-time limit')
add('waiver-limits', c, 'PERFORM private.assert_weekly_add_available(p_league_id, v_season_id, p_member_id);', 'NULL;', 'STMT-DEL submission limit check removed', 'Accept claims after exhausting limit')
add('waiver-limits', p, 'IF v_ineligible IS NOT NULL THEN', 'IF false THEN', 'CONST condition -> false', 'Skip processing-time IR eligibility')
add('skipped-week', 'private.current_add_week', 'weeks.week_end >= v_today', 'weeks.week_end > v_today', 'ROR >= -> >', 'Final skipped-week day maps to next week', 0)
add('skipped-week', 'private.current_add_week', '(v_week_end + 1)::timestamp', '(v_week_end + 0)::timestamp', 'CONST +1 -> +0', 'Report reset one day early')
add('skipped-week', 'private.consume_weekly_add', 'v_week := private.current_add_week_number(p_league_id, p_league_season_id);', 'v_week := private.current_add_week_number(p_league_id, p_league_season_id) + 1;', 'CONST week -> week+1', 'Consume eligible week during skipped week')
add('skipped-week', 'public.commissioner_override_weekly_add_count_atomic', 'v_week := private.current_add_week_number(p_league_id, v_season_id);', 'v_week := private.current_add_week_number(p_league_id, v_season_id) - 1;', 'CONST week -> week-1', 'Override skipped week instead of eligible week')
add('skipped-week', 'private.current_add_week', 'weeks.week_start <= v_today', 'weeks.week_start < v_today', 'ROR <= -> <', 'First eligible day uses upcoming fallback')
add('skipped-week', 'private.current_add_week_number', 'SELECT week.week_number', 'SELECT week.week_number + 1', 'CONST week -> week+1', 'Skip calendar label when allocating weekly usage')
add('skipped-week', 'private.assert_weekly_add_available', '    v_week,\n    0', '    v_week + 1,\n    0', 'CONST week -> week+1', 'Allocate the next week during skipped-week submission')
add('waiver-order', 'public.prevent_season_deactivation_with_pending_waivers', "claim.status = 'pending'::waiver_claim_status", "claim.status <> 'pending'::waiver_claim_status", 'ROR', 'Completed or cancelled claims block the automatic rollover')
add('waiver-order', 'public.prevent_season_deactivation_with_pending_waivers', 'IF FOUND THEN', 'IF false THEN', 'CONST', 'Ignore an unclaimed hold at season rollover', 1)
add('waiver-order', p, "'playoffs'::league_status", "'setup'::league_status", 'CONST', 'Playoff claims never become worker candidates', 0)
add('waiver-order', p, "'offseason'::league_status", "'setup'::league_status", 'CONST', 'Offseason claims never become worker candidates', 0)
add('waiver-order', 'public.expire_waiver_wire_logs', "'playoffs'::league_status", "'setup'::league_status", 'CONST', 'Unclaimed playoff drops never expire')
add('waiver-limits', 'public.expire_waiver_wire_logs', 'AND NOT EXISTS (', 'AND EXISTS (', 'NEG', 'Expire pending holds while retaining unclaimed holds')
add('skipped-week', 'public.set_waiver_clears_at', "INTERVAL '48 hours'", "INTERVAL '2 days'", 'CONST', 'Use calendar days instead of elapsed hours across DST')
add('skipped-week', 'public.set_waiver_clears_at', "INTERVAL '48 hours'", "INTERVAL '47 hours'", 'CONST', 'Clear one elapsed hour too early across DST')
add('skipped-week', 'private.weekly_add_limit_reset_label', 'AT TIME ZONE private.add_week_timezone()', "AT TIME ZONE 'UTC'", 'CONST', 'Render DST-week resets in UTC instead of ET')
add('skipped-week', 'private.current_add_week', '(v_week_end + 1)::timestamp AT TIME ZONE v_zone', "(v_week_end + 1)::timestamp AT TIME ZONE 'UTC'", 'CONST', 'Reset the DST week at UTC midnight')
rows.append(dict(id='waiv-waiver-order-19', area='waiver-order',
                 file='supabase/functions/process-waivers/index.ts', line=92,
                 symbol='processWaiverClaims', operator='STMT-DEL',
                 original='  await reconcilePlayoffScores()', mutated='',
                 canonical='supabase/functions/process-waivers/index.ts', occurrence=0, kind='file',
                 notes='target removed; fix relocated to season boundary (post lane)', retired=True))
add('waiver-order', 'public.expire_waiver_wire_logs', 'season.is_current = true', 'season.is_current = false', 'NEG', 'Current playoff holds never expire')
add('waiver-order', 'public.expire_waiver_wire_logs', 'wwl.clears_at < now()', 'wwl.clears_at > now()', 'ROR', 'Clear future holds and retain mature holds')

add('waiver-limits', 'private.current_add_week', 'weeks.week_start <= v_today', 'weeks.week_start >= v_today', 'ROR', 'Select the next week while inside the merged All-Star range', 0)
add('waiver-limits', 'private.current_add_week', 'SELECT weeks.week_number, weeks.week_end', 'SELECT weeks.week_number, LEAST(weeks.week_end, weeks.week_start + 6)', 'CONST', 'Cap the selected C2 range at seven days, resetting halfway through All-Star', 0)
add('waiver-limits', 'private.current_add_week', '(v_week_end + 1)::timestamp', '(v_week_end + 7)::timestamp', 'CONST', 'Reset six days after the actual merged-week boundary')
add('waiver-limits', 'private.current_add_week', 'v_elapsed_weeks := (v_today - v_last_end - 1) / 7;', 'v_elapsed_weeks := (v_today - v_last_end - 1) / 14;', 'CONST', 'Advance post-schedule buckets every fourteen days after the shortened season', 0)

add('trade-deadline', 'private.create_trade_offer', "v_league.trade_deadline < (now() AT TIME ZONE 'America/New_York')::date", "v_league.trade_deadline <= (now() AT TIME ZONE 'America/New_York')::date", 'ROR', 'Lock proposals on the deadline date instead of the next New York date')
add('trade-deadline', 'public.prevent_trade_acceptance_after_deadline', "v_trade_deadline < (now() AT TIME ZONE 'America/New_York')::date", "v_trade_deadline <= (now() AT TIME ZONE 'America/New_York')::date", 'ROR', 'Lock acceptance on the deadline date instead of the next New York date')

oracles = {
    'initial': [
        ['preference', ['psql', '{db}', '-X', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/db/waiver-preference-order.sql']],
        ['weekly-boundaries', ['psql', '{db}', '-X', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/db/weekly-add-limit-boundaries.sql']],
        ['clearing-window', ['psql', '{db}', '-X', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/db/waiver-clearing-window.sql']],
    ],
    'enhanced': [['season-matrix', ['node', 'tests/e2e/waiver-season-db.mjs']]],
}
oracles['enhanced'] = oracles['initial'] + oracles['enhanced']
oracles['worker'] = [['http-worker', ['node', 'tests/e2e/faab-worker-db.mjs']]]
oracles['boundary'] = [
    ['season-end', ['node', 'tests/e2e/waiver-season-end-db.mjs']],
    ['dst', ['psql', '{db}', '-X', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/db/waiver-dst-boundaries.sql']],
]
oracles['allstar'] = [['merged-limits', ['psql', '{db}', '-X', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/db/limits-all-star-week.sql']]]
(ROOT / 'scripts/mutation/waivers/catalog.json').write_text(json.dumps({'provenance':'SYNTHETIC', 'oracles':oracles,'mutants':rows},indent=2)+'\n')
print(f'{len(rows)} mutants')
