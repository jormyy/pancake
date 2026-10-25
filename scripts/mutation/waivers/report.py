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
boundary = {}
if (evidence/'turn2/boundary-results.jsonl').exists():
    initial.update({r['id']:r for r in rows('turn2/initial-results.jsonl')})
    boundary = {r['id']:r for r in rows('turn2/boundary-results.jsonl')}
    final.update(boundary)
turn3 = {}
if (evidence/'turn3/boundary-results.jsonl').exists():
    initial.update({r['id']:r for r in rows('turn3/initial-results.jsonl')})
    turn3 = {r['id']:r for r in rows('turn3/boundary-results.jsonl')}
    final.update(turn3)
turn5 = {}
if (evidence/'turn5/boundary-results.jsonl').exists():
    turn5 = {r['id']:r for r in rows('turn5/boundary-results.jsonl')}
    final.update(turn5)
turn6 = {}
if (evidence/'turn6/allstar-results.jsonl').exists():
    initial.update({r['id']:r for r in rows('turn6/initial-results.jsonl')})
    turn6 = {r['id']:r for r in rows('turn6/allstar-results.jsonl')}
    final.update(turn6)
turn9 = {}
if (evidence/'t9/allstar-results.jsonl').exists():
    initial.update({r['id']:r for r in rows('t9/initial-results.jsonl')})
    turn9 = {r['id']:r for r in rows('t9/allstar-results.jsonl')}
    final.update(turn9)
retired = {r['id']:r for r in catalog['mutants'] if r.get('retired')}
for key, mutant in retired.items():
    row = {k:mutant[k] for k in ('id','area','file','line','symbol','operator','original','mutated')}
    row.update(applied=False, outcome='invalid', oracles=[], killed_by=[], notes=mutant['notes'])
    initial[key] = dict(row)
    final[key] = row
ids = {r['id'] for r in catalog['mutants']}
assert set(initial) == set(final) == ids
assert all(r['applied'] and 'restored_sha256=' in r['notes'] for key, r in final.items() if key not in retired)
unreached = {
    'waiv-skipped-week-01': 'unreachable in tests: on the last day, the fallback returns the same calendar week. A difference requires overlapping current weeks.',
    'waiv-skipped-week-05': 'unreachable in tests: on the first day, the fallback returns the same calendar week. A difference requires overlapping or misordered calendar weeks.',
}
for key, row in final.items():
    if key in retired:
        continue
    if key in worker:
        row['oracles'] += worker[key]['oracles']
        row['killed_by'] = sorted(set(row['killed_by']+worker[key]['killed_by']))
        row['notes'] += ' | real HTTP worker also kills this mutation'
    source_kind = 'TypeScript' if row['file'].endswith('.ts') else 'SQL'
    row['notes'] = f'SYNTHETIC oracle inputs; REAL-DERIVED repository {source_kind}. ' + row['notes']
    if key in unreached:
        row['notes'] += ' | classification=' + unreached[key]
    for oracle in row['oracles']:
        oracle['log'] = ('t9/' if key in turn9 else 'turn6/' if key in turn6 else 'turn5/' if key in turn5 else 'turn3/' if key in turn3 else 'turn2/' if key in boundary else '') + Path(oracle['log']).name
        oracle['command'] = oracle['command'].replace("'$SUPABASE_DB_URL'", '"$SUPABASE_DB_URL"')
current = [final[m['id']] for m in catalog['mutants']]
result_path = evidence/'results.jsonl'
if (turn5 or turn6 or turn9) and result_path.exists():
    history = rows('results.jsonl')
    with result_path.open('a') as log:
        for row in current:
            if row['id'] in (turn5.keys() | turn6.keys() | turn9.keys()) and row not in history:
                log.write(json.dumps(row)+'\n')
    latest = {row['id']: row for row in rows('results.jsonl')}
    assert latest == final
else:
    result_path.write_text(''.join(json.dumps(row)+'\n' for row in current))
(evidence/'latest-results.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in current))

scores = ['# Measured mutation scores', '', 'Inputs: SYNTHETIC users, leagues, players, standings, dates, and bids. Application definitions are REAL-DERIVED from repository migrations and the executed Edge source.', '',
          'Initial = three existing SQL recipes. Final = those recipes plus the season matrix and the real season-end gate/worker and DST checks for boundary additions. Round 3 runs on integration 53e916ed with the worker refresh removed. Earlier verdicts carry forward; the removed worker mutant is invalid. Six earlier selected kills also pass through authenticated HTTP submission and the real worker.', '',
          '| Area | Initial killed / (killed + survived) | Final killed / (killed + survived) | Total | Invalid | Timeout | Equivalent | Final survived |',
          '|---|---:|---:|---:|---:|---:|---:|---:|']
for area in ['faab','waiver-order','waiver-limits','skipped-week','trade-deadline']:
    before = collections.Counter(r['outcome'] for r in initial.values() if r['area']==area)
    after = collections.Counter(r['outcome'] for r in final.values() if r['area']==area)
    total = sum(after.values())
    scores.append(f'| {area} | {before["killed"]}/{before["killed"]+before["survived"]} | {after["killed"]}/{after["killed"]+after["survived"]} | {total} | {after["invalid"]} | {after["timeout"]} | {after["equivalent"]} | {after["survived"]} |')
total = len(ids)
initial_kills = sum(r['outcome']=='killed' for r in initial.values())
final_kills = sum(r['outcome']=='killed' for r in final.values())
initial_denominator = sum(r['outcome'] in ('killed','survived') for r in initial.values())
final_denominator = sum(r['outcome'] in ('killed','survived') for r in final.values())
scores += ['', f'Overall: {initial_kills}/{initial_denominator} initially; {final_kills}/{final_denominator} finally ({100*final_kills/final_denominator:.2f}%). Total catalog: {total}; invalid: {len(retired)}; timeout: 0; equivalent: 0. Two remain survived. No equivalent verdict is claimed.', '',
           'Round 3 adds two waiver-expiry controls on the integrated build. The retired refresh-call mutation remains recorded as invalid. Raw historical verdicts remain in the turn2 logs. New baseline and killing logs are in turn3/.', '',
           'Tier 2: see turn3/shared-sim-readme.md and HANDOFF.md for the final publication check. No new simulator is built.', '',
           'These results do not prove all waiver behavior through a full season. They measure the catalog and targeted cases only.']
if turn5:
    scores += ['', 'Round 5 integration hygiene: five selected mutants rerun against the residue-tolerant DST recipe. All five remain killed by DST assertions. The 58-entry denominator is unchanged. results.jsonl appends rerun history; latest-results.jsonl has one current verdict per ID. See turn5/boundary-results.jsonl.']
if turn6:
    scores += ['', 'Round 6: four waiver-limits mutants target C2 merged-week range selection, seven-day truncation, reset date and shortened-season fallback. Initial = existing SQL recipes; final adds limits-all-star-week.sql. See turn6/ for measured baselines and kills. All calendars are REAL-DERIVED C2 rows; users and uniform date translations are SYNTHETIC.']
if turn9:
    scores += ['', 'Turn 9: two ROR controls exercise the newly assigned trade-deadline checks. Existing SQL oracles survive both; the extended All-Star recipe kills both. Overlays change actual deployed functions only; no permanent trade definition changes. See t9/ for baselines, exact historical database-clock checkpoints, kills, and twice-green runs. Earlier waiver verdicts carry forward.']
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
if boundary:
    shutil.copyfile(evidence/'turn2/boundary-waiv-skipped-week-08-dst.log',evidence/'red'/'dst-calendar-days.log')
    shutil.copyfile(evidence/'turn2/boundary-waiv-waiver-order-15-season-end.log',evidence/'red'/'unguarded-hold-rollover.log')
    shutil.copyfile(evidence/'turn2/baseline-boundary-dst.log',evidence/'green'/'dst.log')
    shutil.copyfile(evidence/'turn2/baseline-boundary-season-end.log',evidence/'green'/'season-end.log')
    shutil.copyfile(evidence/'turn2/rollover-stall-red.log',evidence/'red'/'rollover-stall.log')
    shutil.copyfile(evidence/'turn2/rollover-stall-green.log',evidence/'green'/'rollover-stall.log')
if turn3:
    shutil.copyfile(evidence/'turn3/boundary-post-reverted-red.log', evidence/'red/rollover-stall.log')
    shutil.copyfile(evidence/'turn3/final-season-end.log', evidence/'green/rollover-stall.log')
    shutil.copyfile(evidence/'turn3/final-season-end.log', evidence/'green/season-end.log')
    shutil.copyfile(evidence/'turn3/final-dst.log', evidence/'green/dst.log')
    for key in turn3:
        if key in retired:
            continue
        shutil.copyfile(evidence/f'turn3/boundary-{key}-season-end.log', evidence/f'red/{key}.log')
if turn5:
    shutil.copyfile(evidence/'turn5/boundary-waiv-skipped-week-08-dst.log', evidence/'red/dst-calendar-days.log')
    shutil.copyfile(evidence/'turn5/baseline-boundary-dst.log', evidence/'green/dst.log')
    for recipe in ['dst', 'worker']:
        green_name = 'waiver-dst' if recipe == 'dst' else 'faab-worker'
        shutil.copyfile(evidence/f'turn5/old-{recipe}-red.log', evidence/f'red/residue-{recipe}.log')
        shutil.copyfile(evidence/f'turn5/green-1-{green_name}.log', evidence/f'green/residue-{recipe}.log')
if turn6:
    shutil.copyfile(evidence/'turn6/allstar-waiv-waiver-limits-16-merged-limits.log', evidence/'red/all-star-seven-day-cap.log')
    shutil.copyfile(evidence/'turn6/baseline-allstar-merged-limits.log', evidence/'green/all-star-week.log')
(evidence/'red'/'README.md').write_text(
    'The current rollover-stall red/green logs come from round3: the integrated boundary fix passes without worker refresh; restoring the old boundary source fails. Historical worker-fix logs remain under turn2/. Other red logs are mutation negative controls.\n'
    if boundary else 'These failures are mutation negative controls. No real application bug is reproduced or fixed. Baseline green logs exercise the same checks without the overlay.\n')
symbols = sorted({m['symbol'] for m in catalog['mutants']})
map_text = ['# Application paths and measured oracles', '',
            'All SQL overlays use canonical statements that match the newest deployed migration. The runner compares pg_get_functiondef hashes before applying each overlay and after each restore. The stack starts from unmodified repository migrations.', '',
            '| Path | Application behavior | Evidence |', '|---|---|---|',
            '| api/waivers.ts | Authenticated create/edit/cancel/reorder routes pass the user ID to the atomic RPCs. | HTTP worker baseline; matrix preference; edit/concurrency recipes |',
            '| process-waivers/index.ts + drain.ts | ET date; bounded batches; notifications; expiry. | HTTP worker; backlog; real automatic season-end regression |',
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
            'Permanent SQL function redefinitions: none. Score refresh belongs to the integrated season boundary. The waiver worker only handles waivers. Temporary SQL and historical worker mutation overlays:', '']
map_text += ['- '+s for s in symbols]
map_text += ['', 'Exact newest deployed locations are in catalog.json and results.jsonl.']
(evidence/'application-map.md').write_text('\n'.join(map_text)+'\n')
print(f'{total} catalog rows; {final_kills} killed; {len(unreached)} survivors')
