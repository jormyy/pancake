import collections
import json
import shutil
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[3]
evidence = Path(sys.argv[1]).resolve()
catalog = json.loads((root/'scripts/mutation/waivers/catalog.json').read_text())


def rows(name):
    return [json.loads(line) for line in (evidence/name).read_text().splitlines()]


initial = {r['id']:r for r in rows('initial-results.jsonl')}
final = {r['id']:r for r in rows('enhanced-results.jsonl')}
worker = {r['id']:r for r in rows('worker-results.jsonl')}
ids = {r['id'] for r in catalog['mutants']}
assert set(initial) == set(final) == ids
assert all(r['applied'] and 'restored_sha256=' in r['notes'] for r in final.values())
assert len(rows('initial-results.jsonl')) == len(ids)
assert len(rows('enhanced-results.jsonl')) == len(ids)
unreached = {
    'waiv-skipped-week-01': 'unreachable in tests: on the last day, the fallback returns the same calendar week. A difference requires overlapping current weeks.',
    'waiv-skipped-week-05': 'unreachable in tests: on the first day, the fallback returns the same calendar week. A difference requires overlapping or misordered calendar weeks.',
}
for key, row in final.items():
    if key in worker:
        row['oracles'] += worker[key]['oracles']
        row['killed_by'] = sorted(set(row['killed_by']+worker[key]['killed_by']))
        row['notes'] += ' | real HTTP worker also kills this mutation'
    row['notes'] = 'SYNTHETIC oracle inputs; REAL-DERIVED repository SQL. ' + row['notes']
    if key in unreached:
        row['notes'] += ' | classification=' + unreached[key]
    for oracle in row['oracles']:
        oracle['log'] = Path(oracle['log']).name
        oracle['command'] = oracle['command'].replace("'$SUPABASE_DB_URL'", '"$SUPABASE_DB_URL"')
(evidence/'results.jsonl').write_text(''.join(json.dumps(final[m['id']])+'\n' for m in catalog['mutants']))
scores = ['# Measured mutation scores', '', 'Inputs: SYNTHETIC users, leagues, players, standings, dates, and bids. Function definitions are REAL-DERIVED from the repository migrations.', '',
          'Initial = three existing SQL recipes. Final = those recipes plus the new season matrix. Six selected final kills also pass through authenticated HTTP submission and the real worker.', '',
          '| Area | Initial killed / (killed + survived) | Final killed / (killed + survived) | Total | Invalid | Timeout | Equivalent | Final survived |',
          '|---|---:|---:|---:|---:|---:|---:|---:|']
for area in ['faab','waiver-order','waiver-limits','skipped-week']:
    before = collections.Counter(r['outcome'] for r in initial.values() if r['area']==area)
    after = collections.Counter(r['outcome'] for r in final.values() if r['area']==area)
    total = sum(after.values())
    scores.append(f'| {area} | {before["killed"]}/{before["killed"]+before["survived"]} | {after["killed"]}/{after["killed"]+after["survived"]} | {total} | {after["invalid"]} | {after["timeout"]} | {after["equivalent"]} | {after["survived"]} |')
total = len(ids)
initial_kills = sum(r['outcome']=='killed' for r in initial.values())
final_kills = sum(r['outcome']=='killed' for r in final.values())
scores += ['', f'Overall: {initial_kills}/{total} initially; {final_kills}/{total} finally ({100*final_kills/total:.2f}%). Gain: {final_kills-initial_kills} additional killed mutations. All {total} apply; none is invalid or times out. Two remain survived. No equivalent verdict is claimed.', '',
           'Tier 2: not run. The published shared simulator has no waiver segment and explicitly says no restored segment has passed. See shared-sim-readme.md. No new simulator is built.', '',
           'These results do not prove all waiver behavior through a full season. They measure the catalog and targeted cases only.']
(evidence/'scores.md').write_text('\n'.join(scores)+'\n')
survivors = ['# Every initial survivor', '', '| Mutant | Initial classification | Final result | Killing check or remaining limit |', '|---|---|---|---|']
for mutant in catalog['mutants']:
    key = mutant['id']
    if initial[key]['outcome'] != 'survived':
        continue
    after = final[key]
    classification = 'unreachable in tests' if key in unreached else 'missing assertion / weak oracle'
    detail = unreached.get(key, ', '.join(after['killed_by']) + '; see its failing oracle log and baseline-green.log')
    survivors.append(f'| {key} | {classification} | {after["outcome"]} | {detail} |')
survivors += ['', 'The two remaining changes are masked by the existing fallback on chronological, non-overlapping calendars. The table does not enforce calendar non-overlap, so they remain survivors rather than receiving an unconditional equivalent verdict.', '',
              'No artificial overlapping or misordered NBA calendar is introduced to claim a kill. This is a remaining coverage limit, not a reproduced application bug.']
(evidence/'survivors.md').write_text('\n'.join(survivors)+'\n')
(evidence/'red').mkdir(exist_ok=True)
(evidence/'green').mkdir(exist_ok=True)
shutil.copyfile(evidence/'enhanced-waiv-faab-03-season-matrix.log',evidence/'red'/'wrong-bid-order.log')
shutil.copyfile(evidence/'worker-waiv-waiver-limits-04-http-worker.log',evidence/'red'/'missing-add-consumption-http.log')
shutil.copyfile(evidence/'baseline-enhanced-season-matrix.log',evidence/'green'/'season-matrix.log')
shutil.copyfile(evidence/'baseline-worker-http-worker.log',evidence/'green'/'http-worker.log')
(evidence/'red'/'README.md').write_text('These failures are mutation negative controls. No real application bug is reproduced or fixed. Baseline green logs exercise the same checks without the overlay.\n')
symbols = sorted({m['symbol'] for m in catalog['mutants']})
map_text = ['# Application paths and measured oracles', '',
            'All SQL overlays use canonical statements that match the newest deployed migration. The runner compares pg_get_functiondef hashes before applying each overlay and after each restore. The stack starts from unmodified repository migrations.', '',
            '| Path | Application behavior | Evidence |', '|---|---|---|',
            '| api/waivers.ts | Authenticated create/edit/cancel/reorder routes pass the user ID to the atomic RPCs. | HTTP worker baseline; matrix preference; edit/concurrency recipes |',
            '| process-waivers/index.ts + drain.ts | ET date; bounded batch RPC loop; notifications after committed batches; expiry after drain. | HTTP worker; backlog; preference concurrency |',
            '| cron → invoke_edge_function_at_et_time | Every 15 minutes; due from 03:00 ET onward; daily dispatch claim; retries are reconciled separately. | cron-catchup recipe; newest scheduling migration 20261018000002 |',
            '| create_waiver_claim_atomic | Weekly limit checked at submission. Rolling bids become zero. FAAB permits zero and exact balance. Claims stay submit-able until holds clear. | matrix; HTTP; clearing-window |',
            '| process_next_waiver_claim_atomic | Due date ASC, FAAB bid DESC, waiver priority ASC, claim_order ASC, submitted_at ASC, id ASC. Rechecks budget, limits, roster and IR. Winner pays and moves last; losers keep funds and priority. | matrix; all mutation logs |',
            '| add_free_agent_atomic | Shares assert_weekly_add_available and consume_weekly_add with waiver wins. | matrix; HTTP first eligible week |',
            '| release_roster_player_to_waivers / set_waiver_clears_at | Drops hold players for exactly 48 hours. Due claims process at equality; uncleared holds still block free-agent adds. | matrix exact equality and drop; clearing-window |',
            '| create_league / join_league_by_invite_code | Initial owner has priority 1; a joining member follows max priority. Triggers seed each member budget. | every matrix fixture; HTTP setup |',
            '| advance_season_atomic | Pending claims/holds block rollover. New season resets FAAB to starting budget. Previous balances stay in history. Priorities rebuild from reverse standings; ties use member ID. | matrix rollover; dynasty-rules voided-standings check |',
            '| update_league_settings_atomic(skipped_weeks=[1]) | Skips scoring week 1. Add counters still use the scheduled calendar. A skipped-week add consumes week 1; week 2 starts a fresh bucket, without relabeling it week 1. | matrix and HTTP settings paths |',
            '| trades | Trade code has no call to consume_weekly_add/assert_weekly_add_available. Trades can clear pending drop selections; league/team locks serialize competing moves. | trade-waiver concurrency and cross-league recipes; source read |', '',
            'The tests move SYNTHETIC calendar rows around the actual ET date. They exercise exact SQL timestamp equality, ET reset rendering, and first/last scheduled dates. They do not freeze the worker clock across a real midnight or DST transition.', '',
            'Permanent function redefinitions: none. Temporary mutation overlays:', '']
map_text += ['- '+s for s in symbols]
map_text += ['', 'Exact newest deployed locations are in catalog.json and results.jsonl.']
(evidence/'application-map.md').write_text('\n'.join(map_text)+'\n')
print(f'{total} catalog rows; {final_kills} killed; {len(unreached)} survivors')
