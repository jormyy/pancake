import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

// Turn-10 notification mutants. `rerun` retargets superseded verdicts at the
// c392cad7 definitions (run before migration 280); `new` covers the worker-chain
// proofs and the auction turn fix (run after it).
const phase = Deno.args[0]
assert.ok(phase === 'rerun' || phase === 'new', 'usage: t10.ts rerun|new')
const db = Deno.env.get('SUPABASE_DB_URL')!, evidence = Deno.env.get('NOTIF_EVIDENCE')!
const port = Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322'
assert.match(port, /^\d+$/)
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname) && new URL(db).port === port)
assert.ok(path.isAbsolute(evidence) && !evidence.startsWith(Deno.cwd() + '/'))
const base = 'c392cad799c2b52feead508f643c2576b6d7f33b'
const q = (value: string) => `'${value.replaceAll("'", "''")}'`
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function sql(source: string) {
  const result = spawnSync('psql', [db, '-XqAtv', 'ON_ERROR_STOP=1'], { input: source, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
assert.equal(sql("SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='20261020000280'"), phase === 'rerun' ? '0' : '1', 'Reruns use the c392cad7 definitions; new mutants need migration 280')
const deno = (recipe: string, net = '127.0.0.1', run = 'psql') => ['deno', 'run', '--no-lock', '--check', '--allow-env', '--allow-read', '--allow-write', `--allow-net=${net}`, `--allow-run=${run}`, `supabase/tests/db/${recipe}.ts`]
const oracles: Record<string, { kind: string; command: string[] }> = {
  overhaul: { kind: 'ts-module-db', command: ['deno', 'run', '--no-lock', '--check', '--allow-env', '--allow-net=127.0.0.1', '--allow-run=psql', 'supabase/tests/db/notif-overhaul.ts'] },
  staleness: { kind: 'db-deployed', command: ['psql', db, '-X', '-v', 'ON_ERROR_STOP=1', '-f', 'tests/db/notif-staleness.sql'] },
  gate: { kind: 'db-deployed', command: ['psql', db, '--set', 'ON_ERROR_STOP=1', '-f', 'tests/db/process-trades-gate.sql'] },
  round3: { kind: 'db-deployed', command: ['psql', db, '-XqAtv', 'ON_ERROR_STOP=1', '-v', 'notif_case=all', '-f', 'tests/db/notif-round3.sql'] },
  'pause-resume': { kind: 'edge-http', command: deno('notif-pause-resume', '127.0.0.1,0.0.0.0', 'psql,docker') },
  't9-draft': { kind: 'edge-http', command: deno('notif-t9-draft') },
  waivers: { kind: 'edge-http', command: deno('notif-t10-waivers') },
  'sync-players': { kind: 'edge-http', command: deno('notif-t10-sync-players') },
  'watch-drop': { kind: 'edge-http', command: deno('notif-t10-watch-drop') },
  auction: { kind: 'edge-http', command: deno('notif-t10-auction') },
}
type Mutant = { id: string; operator: string; original: string; mutated: string; oracle: string; prior_sha: string | null; prior_outcome: string | null; symbol?: string; file?: string; trigger?: { table: string; name: string }; note?: string }
const prior = (sha: string) => ({ prior_sha: sha, prior_outcome: 'killed' })
const fresh = { prior_sha: null, prior_outcome: null }
const reruns: Mutant[] = [
  { id: 'N05', symbol: 'public.claim_notification_outbox_atomic(integer,integer)', original: "SET suppressed_at = now(), suppression_reason = 'preferences_disabled'", mutated: "SET suppressed_at = NULL, suppression_reason = 'preferences_disabled'", operator: 'leave preference-suppressed rows unsuppressed', oracle: 'overhaul', ...prior('d396e9b3') },
  { id: 'N06', symbol: 'public.notif_scan_due_atomic(timestamp with time zone)', original: "pick.timer_expires_at <= p_now + interval '1 minute'", mutated: "pick.timer_expires_at < p_now + interval '1 minute'", operator: 'exclude the exact one-minute timer boundary', oracle: 'overhaul', ...prior('d396e9b3') },
  { id: 'N08', symbol: 'public.notif_begin_web_atomic(uuid,uuid)', original: "IF r.web_delivered_at IS NOT NULL THEN RETURN 'delivered'; END IF;", mutated: "IF r.web_delivered_at IS NOT NULL THEN RETURN 'send'; END IF;", operator: 'resend an already delivered web push', oracle: 'overhaul', ...prior('d396e9b3') },
  { id: 'N10', symbol: 'private.notif_is_stale(text,jsonb)', original: ' OR p.picked_at IS NOT NULL', mutated: '', operator: 'remove picked-pick staleness', oracle: 'staleness', ...prior('1a1c0147') },
  { id: 'N11', symbol: 'private.notif_is_stale(text,jsonb)', original: " OR d.status <> 'in_progress'", mutated: '', operator: 'remove draft-status staleness', oracle: 'staleness', ...prior('1a1c0147'), note: "target-removed: 179 replaced it with OR d.status NOT IN ('in_progress','paused'); see N11R" },
  { id: 'N11R', symbol: 'private.notif_is_stale(text,jsonb)', original: " OR d.status NOT IN ('in_progress','paused')", mutated: '', operator: 'remove draft-status staleness (replacement for N11 on the current definition)', oracle: 'staleness', ...fresh },
  { id: 'N12', symbol: 'public.notif_scan_due_atomic(timestamp with time zone)', original: 'pick.timer_expires_at > p_now', mutated: 'pick.timer_expires_at >= p_now', operator: 'include an already expired timer', oracle: 'staleness', ...prior('d396e9b3') },
  { id: 'N13', symbol: 'private.notif_is_stale(text,jsonb)', original: 'deadline <= clock_timestamp()', mutated: 'deadline >= clock_timestamp()', operator: 'invert expired-deadline staleness', oracle: 'staleness', ...prior('1a1c0147') },
  { id: 'N14', symbol: 'public.invoke_process_trades_if_due()', original: 'AND queued.available_at <= now()\n      AND private.notif_draft_deferred_until', mutated: 'AND private.notif_draft_deferred_until', operator: 'remove send availability predicate (first of two identical lines: the unsent-row clause, disambiguated by its next line)', oracle: 'gate', ...prior('d396e9b3') },
  { id: 'N23', symbol: 'private.notif_is_stale(text,jsonb)', original: 'AND NOT m.is_finalized AND NOT m.is_voided', mutated: 'AND NOT m.is_voided', operator: 'keep close-matchup alerts after finalization', oracle: 'round3', ...prior('29d4bf2b') },
  { id: 'N24', symbol: 'private.notif_is_stale(text,jsonb)', original: 'AND abs(m.home_points-m.away_points)<=greatest(10,(m.home_points+m.away_points)*0.025)', mutated: '', operator: 'remove close-margin staleness', oracle: 'round3', ...prior('29d4bf2b') },
  { id: 'N34', symbol: 'private.notif_draft_trigger()', original: "PERFORM public.invoke_edge_function('process-trades');", mutated: 'PERFORM 1;', operator: 'remove immediate resume wake', oracle: 'pause-resume', ...prior('723eefa7') },
  { id: 'N41', symbol: 'private.notif_draft_audit_trigger()', original: 'WHERE league_id=d.league_id LOOP', mutated: "WHERE league_id=d.league_id AND role='commissioner' LOOP", operator: 'exclude managers from human-resume recipients', oracle: 't9-draft', ...prior('3b140db4') },
  { id: 'N42', symbol: 'private.notif_draft_audit_trigger()', original: "notif_enqueue('draft_resumed',NEW.id::text", mutated: "notif_enqueue('draft_resumed',d.id::text", operator: 'collapse separate human-resume occurrences to one draft key', oracle: 't9-draft', ...prior('3b140db4') },
  { id: 'N44', symbol: 'private.notif_draft_audit_trigger()', original: "NEW.action='resume'", mutated: "NEW.action<>'resume'", operator: 'replace explicit resume action predicate with its negation', oracle: 't9-draft', ...prior('3b140db4') },
  { id: 'N07R', symbol: 'private.notif_draft_clock(uuid)', original: 'p.id::text,d.league_id,p.member_id', mutated: 'p.id::text,d.league_id,(SELECT seat.member_id FROM public.draft_orders seat WHERE seat.draft_id=d.id AND seat.position=1)', operator: 'send the on-clock alert to the first seat instead of the picker', oracle: 't9-draft', ...fresh, note: 'N07 (unchanged target) mutated to d.created_by_member_id, a column drafts does not have, so its recorded kill was a runtime error; this is a behavioral replacement' },
]
const created: Mutant[] = [
  { id: 'N55', symbol: 'private.notif_waiver_trigger()', original: "WHEN NEW.status IN ('failed_priority','failed_roster') THEN 'waiver_claim_lost'", mutated: "WHEN NEW.status IN ('failed_priority') THEN 'waiver_claim_lost'", operator: 'drop the loss alert for roster and add-limit failures', oracle: 'waivers', ...fresh },
  { id: 'N56', symbol: 'private.notif_waiver_trigger()', original: "COALESCE(NEW.failure_reason,'Your waiver claim succeeded.')", mutated: "'Your waiver claim succeeded.'", operator: 'hide the settlement reason from the loser', oracle: 'waivers', ...fresh },
  { id: 'N57', file: 'supabase/functions/sync-players/index.ts', original: 'injury_status: record.injury_status', mutated: 'injury_status: null', operator: 'sync-players drops the ESPN injury status before import', oracle: 'sync-players', ...fresh },
  { id: 'N58', symbol: 'private.notif_player_trigger()', original: 'IF OLD.injury_status IS NOT DISTINCT FROM NEW.injury_status THEN RETURN NEW; END IF;', mutated: 'IF false THEN RETURN NEW; END IF;', operator: 'notify on a repeated unchanged feed status', oracle: 'sync-players', ...fresh },
  { id: 'N59', symbol: 'private.release_roster_player_to_waivers(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,text)', original: "p_member_id,\n    now() + interval '48 hours'", mutated: "NULL,\n    now() + interval '48 hours'", operator: 'claim/trade release forgets the dropping member', oracle: 'watch-drop', ...fresh },
  { id: 'N60', symbol: 'public.complete_accepted_trade_atomic(uuid)', original: 'IF v_league.allow_inactive_trades THEN\n    FOR v_drop IN', mutated: 'IF false THEN\n    FOR v_drop IN', operator: 'skip a trade planned drop', oracle: 'watch-drop', ...fresh },
  { id: 'N61', symbol: 'public.drop_player_atomic(uuid,uuid,uuid)', original: 'v_rp.member_id,\n    v_clears_at', mutated: 'NULL,\n    v_clears_at', operator: 'manager drop (overflow, drop-and-add) forgets the dropping member', oracle: 'watch-drop', ...fresh },
  { id: 'N62', symbol: 'private.notif_draft_clock(uuid)', original: "d.id::text || ':nomination:' || resets || ':' || d.current_nomination_order,d.league_id,nominator", mutated: "d.id::text || ':nomination:' || gen_random_uuid(),d.league_id,nominator", operator: 'auction turn occurrence not keyed by nomination order', oracle: 'auction', ...fresh },
  { id: 'N63', symbol: 'private.notif_is_stale(text,jsonb)', original: "\n      OR EXISTS (SELECT 1 FROM public.nominations WHERE draft_id = d.id AND status = 'open');", mutated: ';', operator: 'auction turn stays live after the nominator nominates', oracle: 'auction', ...fresh },
  { id: 'N64', symbol: 'private.notif_draft_clock(uuid)', original: 'position = (d.current_nomination_order % seats) + 1', mutated: 'position = ((d.current_nomination_order - 1) % seats) + 1', operator: 'next-nominator seat resolves to the current nominator', oracle: 'auction', ...fresh },
  { id: 'N65', trigger: { table: 'public.drafts', name: 'notif_auction_turn_trigger' }, original: 'ENABLE', mutated: 'DISABLE', operator: 'no turn alert when a closed nomination advances the order', oracle: 'auction', ...fresh },
  { id: 'N66', trigger: { table: 'public.draft_orders', name: 'notif_draft_order_trigger' }, original: 'ENABLE', mutated: 'DISABLE', operator: 'no turn alert when an auction starts', oracle: 'auction', ...fresh },
  { id: 'N67', symbol: 'private.notif_draft_clock(uuid)', original: "d.id::text || ':nomination:' || resets || ':' || d.current_nomination_order,d.league_id,nominator", mutated: "d.id::text || ':nomination:' || d.current_nomination_order,d.league_id,nominator", operator: 'auction turn key ignores the reset generation', oracle: 'auction', ...fresh },
  { id: 'N68', trigger: { table: 'public.draft_audit_logs', name: 'notif_draft_reset_trigger' }, original: 'ENABLE', mutated: 'DISABLE', operator: 'no turn alert after a reset restarts the auction', oracle: 'auction', ...fresh },
]
const mutants = phase === 'rerun' ? reruns : created
function oracle(label: string, key: string) {
  const { command } = oracles[key]
  const start = performance.now()
  const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 420000 })
  const log = path.join(evidence, label + '.log')
  writeFileSync(log, (result.stdout ?? '') + (result.stderr ?? ''))
  const record = { name: label, command: command.map(part => part === db ? '$SUPABASE_DB_URL' : part), exit: result.status ?? -1, seconds: (performance.now() - start) / 1000, log }
  appendFileSync(path.join(evidence, 'commands.jsonl'), JSON.stringify(record) + '\n')
  console.log(JSON.stringify(record))
  return record
}
// A kill must be an assertion or a raised test expectation, not a crash in the harness.
const behavioral = (log: string) => /AssertionError|ERROR: /.test(log) && !/error: TS\d+|Module not found|syntax error|does not exist|has no field|violates|null value in column|invalid input syntax|Refusing|could not connect/i.test(log)
function locate(mutant: Mutant) {
  if (mutant.file) return { file: mutant.file, line: readFileSync(mutant.file, 'utf8').split(mutant.original)[0].split('\n').length }
  const needle = mutant.trigger ? `trigger ${mutant.trigger.name} ` : 'create or replace function ' + mutant.symbol!.split('(')[0].toLowerCase() + '('
  let file = '', line = 0
  for (const name of readdirSync('supabase/migrations').filter(name => name.endsWith('.sql') && (phase === 'new' || name < '20261020000280')).sort()) {
    const source = readFileSync('supabase/migrations/' + name, 'utf8'), lower = source.toLowerCase(), index = lower.indexOf(needle)
    if (index < 0) continue
    file = 'supabase/migrations/' + name
    const target = source.indexOf(mutant.original.split('\n')[0], index)
    line = source.slice(0, target >= 0 && !mutant.trigger ? target : index).split('\n').length
  }
  return { file, line }
}
const probe = (mutant: Mutant) => mutant.file ? readFileSync(mutant.file, 'utf8')
  : mutant.trigger ? sql(`SELECT tgenabled FROM pg_trigger WHERE tgname=${q(mutant.trigger.name)} AND tgrelid=${q(mutant.trigger.table)}::regclass`)
  : sql(`SELECT pg_get_functiondef(${q(mutant.symbol!)}::regprocedure)`)
const baseline: Record<string, number> = {}
for (const key of new Set(mutants.map(mutant => mutant.oracle))) baseline[key] = oracle(`t10-${phase}-baseline-${key}`, key).exit
const outcomes: Record<string, number> = { killed: 0, survived: 0, invalid: 0, timeout: 0, equivalent: 0 }
for (const mutant of mutants) {
  const { file, line } = locate(mutant)
  const before = probe(mutant)
  let applied = false, outcome = 'invalid', reason = '', mutantExit: number | null = null, seconds = 0, log = ''
  try {
    assert.ok(file && line, 'Target location')
    assert.equal(baseline[mutant.oracle], 0, 'baseline-red')
    if (mutant.trigger) {
      assert.equal(before, 'O', 'Trigger enabled before mutation')
      sql(`ALTER TABLE ${mutant.trigger.table} DISABLE TRIGGER ${mutant.trigger.name}`)
    } else {
      const count = before.split(mutant.original).length - 1
      if (count === 0) { reason = 'target-removed'; throw new Error(mutant.note ?? 'target-removed') }
      assert.equal(count, 1, 'Operator must apply exactly once')
      if (mutant.file) writeFileSync(mutant.file, before.replace(mutant.original, mutant.mutated))
      else sql(before.replace(mutant.original, mutant.mutated))
    }
    applied = true
    assert.notEqual(hash(probe(mutant)), hash(before))
    const result = oracle(`t10-mutation-${mutant.id}`, mutant.oracle)
    mutantExit = result.exit; seconds = result.seconds; log = result.log
    const text = readFileSync(result.log, 'utf8')
    if (result.exit === 0) { outcome = 'survived'; reason = 'oracle passed with the mutant applied' }
    else if (result.exit === -1) { outcome = 'timeout'; reason = 'oracle exceeded 420 s' }
    else if (behavioral(text)) { outcome = 'killed'; reason = (text.match(/AssertionError[^\n]*\n?[^\n]*|ERROR: {2}[^\n]*/)?.[0] ?? '').trim().slice(0, 300) }
    else { outcome = 'invalid'; reason = 'non-behavioral failure: ' + (text.match(/error[^\n]*/i)?.[0] ?? '').slice(0, 200) }
  } catch (error) { if (!reason) reason = String(error).slice(0, 300); else reason += ': ' + String(error).slice(0, 200) }
  finally {
    if (mutant.file) writeFileSync(mutant.file, before)
    else if (mutant.trigger) sql(`ALTER TABLE ${mutant.trigger.table} ENABLE TRIGGER ${mutant.trigger.name}`)
    else sql(before)
  }
  const restored = hash(probe(mutant))
  assert.equal(restored, hash(before), `${mutant.id}: restore must be byte-identical`)
  outcomes[outcome]++
  const record = { id: mutant.id, lane: 'notif', area: 'notifications', file, line, symbol: mutant.symbol ?? mutant.trigger?.name ?? mutant.file, operator: mutant.operator, original: mutant.original, mutated: mutant.mutated, base_sha: base, prior_sha: mutant.prior_sha, prior_outcome: mutant.prior_outcome, applied, outcome, reason: mutant.note && outcome !== 'invalid' ? `${reason} (${mutant.note})` : reason, oracle_kind: oracles[mutant.oracle].kind, oracle_cmds: [oracles[mutant.oracle].command.map(part => part === db ? '$SUPABASE_DB_URL' : part).join(' ')], baseline_exit: baseline[mutant.oracle], mutant_exit: mutantExit, seconds, log, restore_sha256: restored }
  appendFileSync(path.join(evidence, 'results.jsonl'), JSON.stringify(record) + '\n')
  console.log(JSON.stringify(record))
}
console.log(JSON.stringify({ phase, total: mutants.length, ...outcomes }))
