import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const target = new URL(Deno.env.get('SUPABASE_DB_URL') ?? '')
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.port !== '57822') throw new Error('Only the notification lane database is allowed')
const evidence = Deno.env.get('NOTIF_EVIDENCE')
if (!evidence || !path.isAbsolute(evidence) || evidence.startsWith(`${Deno.cwd()}/`)) throw new Error('Evidence must point outside the repository')
mkdirSync(evidence, { recursive: true })
const sql = (query: string) => {
    const result = spawnSync('psql', [target.href, '-XqAt', '--set', 'ON_ERROR_STOP=1'], { input: query, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
}
const oracle = (name: string) => {
    const started = performance.now()
    const result = spawnSync('deno', ['run', '--allow-env', '--allow-net=127.0.0.1', '--allow-run=psql', 'supabase/tests/db/notif-overhaul.ts'], { encoding: 'utf8', timeout: 60000 })
    const seconds = (performance.now() - started) / 1000
    const log = path.join(evidence, `${name}.log`)
    writeFileSync(log, result.stdout + result.stderr)
    return { name, command: 'deno run --allow-env --allow-net=127.0.0.1 --allow-run=psql supabase/tests/db/notif-overhaul.ts', exit: result.status ?? -1, seconds, log }
}
const baseline = oracle('mutation-baseline')
appendFileSync(path.join(evidence, 'commands.jsonl'), `${JSON.stringify(baseline)}\n`)
if (baseline.exit !== 0) throw new Error('Mutation oracle fails on baseline')
const targets = [
    { id: 'N01', file: 'private/notif_enqueue.sql', symbol: 'private.notif_enqueue(text,text,uuid,uuid,jsonb)', operator: 'replace stable occurrence argument with random UUID', original: "p_event || ':' || p_occurrence || ':' || member.id", mutated: "p_event || ':' || gen_random_uuid()::text || ':' || member.id" },
    { id: 'N02', file: 'private/notif_enqueue.sql', symbol: 'private.notif_enqueue(text,text,uuid,uuid,jsonb)', operator: 'remove league recipient predicate', original: 'AND member.league_id = p_league_id', mutated: '' },
    { id: 'N03', file: 'private/notif_preference_enabled.sql', symbol: 'private.notif_preference_enabled(uuid,text,text)', operator: 'negate master condition', original: 'p.master_enabled IS FALSE', mutated: 'p.master_enabled IS TRUE' },
    { id: 'N04', file: 'private/notif_preference_enabled.sql', symbol: 'private.notif_preference_enabled(uuid,text,text)', operator: 'remove category gate', original: 'IF (p.category_settings->>COALESCE(e.category,p_category))::boolean IS FALSE THEN RETURN false; END IF;', mutated: '' },
    { id: 'N05', file: 'public/claim_notification_outbox_atomic.sql', symbol: 'public.claim_notification_outbox_atomic(integer,integer)', operator: 'remove suppression timestamp update', original: "SET suppressed_at = now(), suppression_reason = 'preferences_disabled'", mutated: "SET suppressed_at = NULL, suppression_reason = 'preferences_disabled'" },
    { id: 'N06', file: 'public/notif_scan_due_atomic.sql', symbol: 'public.notif_scan_due_atomic(timestamp with time zone)', operator: 'boundary <= to <', original: "pick.timer_expires_at <= p_now + interval '1 minute'", mutated: "pick.timer_expires_at < p_now + interval '1 minute'" },
    { id: 'N07', file: 'private/notif_draft_clock.sql', symbol: 'private.notif_draft_clock(uuid)', operator: 'recipient argument swap', original: 'p.id::text,d.league_id,p.member_id', mutated: 'p.id::text,d.league_id,d.created_by_member_id' },
    { id: 'N08', file: 'public/notif_begin_web_atomic.sql', symbol: 'public.notif_begin_web_atomic(uuid,uuid)', operator: 'change delivered return to send', original: "IF r.web_delivered_at IS NOT NULL THEN RETURN 'delivered'; END IF;", mutated: "IF r.web_delivered_at IS NOT NULL THEN RETURN 'send'; END IF;" },
    { id: 'N09', file: 'private/notif_preference_enabled.sql', symbol: 'private.notif_preference_enabled(uuid,text,text)', operator: 'legacy column swap', original: 'IF (to_jsonb(p)->>v_legacy)::boolean IS FALSE THEN RETURN false; END IF;', mutated: "IF (to_jsonb(p)->>'activity_enabled')::boolean IS FALSE THEN RETURN false; END IF;" },
]
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
for (const mutant of targets) {
    const filename = `supabase/sql/functions/by-name/${mutant.file}`
    const source = readFileSync(filename, 'utf8')
    const originalDefinition = sql(`SELECT pg_get_functiondef('${mutant.symbol}'::regprocedure)`)
    const line = source.slice(0, source.indexOf(mutant.original)).split('\n').length
    const latestMigration = readdirSync('supabase/migrations').filter(name => name.endsWith('.sql')).sort().reverse().find(name => readFileSync(`supabase/migrations/${name}`, 'utf8').includes(`CREATE OR REPLACE FUNCTION ${mutant.symbol.split('(')[0]}(`))!
    const migrationFile = `supabase/migrations/${latestMigration}`
    const migrationSource = readFileSync(migrationFile, 'utf8')
    const deployedLine = migrationSource.slice(0, migrationSource.indexOf(mutant.original)).split('\n').length
    const record = { id: mutant.id, area: 'notifications', file: migrationFile, line: deployedLine || line, symbol: mutant.symbol, operator: mutant.operator, original: mutant.original, mutated: mutant.mutated, applied: false, outcome: 'invalid', oracles: [] as ReturnType<typeof oracle>[], killed_by: [] as string[], notes: '' }
    try {
        if (!source.includes(mutant.original)) throw new Error('Operator does not apply')
        sql(source.replace(mutant.original, mutant.mutated))
        record.applied = true
        const result = oracle(`mutation-${mutant.id}`)
        record.oracles.push(result)
        record.outcome = result.exit === 0 ? 'survived' : result.exit === -1 ? 'timeout' : 'killed'
        if (record.outcome === 'killed') record.killed_by.push(result.name)
        if (record.outcome === 'survived') record.notes = 'Missing assertion or unreachable path; inspect the oracle log before acceptance.'
    } catch (error) {
        record.notes = String(error)
    } finally {
        sql(originalDefinition)
        if (hash(sql(`SELECT pg_get_functiondef('${mutant.symbol}'::regprocedure)`)) !== hash(originalDefinition)) throw new Error(`Restore hash failed for ${mutant.id}`)
    }
    appendFileSync(path.join(evidence, 'results.jsonl'), `${JSON.stringify(record)}\n`)
    console.log(`${record.id} ${record.outcome}`)
}
const restored = oracle('mutation-restored')
appendFileSync(path.join(evidence, 'commands.jsonl'), `${JSON.stringify(restored)}\n`)
if (restored.exit !== 0) throw new Error('Restored baseline failed')
