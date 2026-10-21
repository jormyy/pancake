import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const target = new URL(Deno.env.get('SUPABASE_DB_URL') ?? '')
const port = Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322'
if (!/^\d+$/.test(port) || !['127.0.0.1', 'localhost'].includes(target.hostname) || target.port !== port) throw new Error('Only the configured loopback test database is allowed')
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
    const result = spawnSync('psql', [target.href, '-XqAt', '--set', 'ON_ERROR_STOP=1', '-f', 'tests/db/notif-staleness.sql'], { encoding: 'utf8', timeout: 60000 })
    const seconds = (performance.now() - started) / 1000
    const log = path.join(evidence, `${name}.log`)
    writeFileSync(log, result.stdout + result.stderr)
    return { name, command: 'psql $SUPABASE_DB_URL -XqAt --set ON_ERROR_STOP=1 -f tests/db/notif-staleness.sql', exit: result.status ?? -1, seconds, log }
}
const baseline = oracle('r2-mutation-baseline')
appendFileSync(path.join(evidence, 'commands.jsonl'), `${JSON.stringify(baseline)}\n`)
if (baseline.exit !== 0) throw new Error('Mutation oracle fails on baseline')
const targets = [
    { id: 'N10', file: 'private/notif_is_stale.sql', symbol: 'private.notif_is_stale(text,jsonb)', operator: 'remove completed-pick stale predicate', original: ' OR p.picked_at IS NOT NULL', mutated: '' },
    { id: 'N11', file: 'private/notif_is_stale.sql', symbol: 'private.notif_is_stale(text,jsonb)', operator: 'remove inactive-draft stale predicate', original: " OR d.status <> 'in_progress'", mutated: '' },
    { id: 'N12', file: 'public/notif_scan_due_atomic.sql', symbol: 'public.notif_scan_due_atomic(timestamp with time zone)', operator: 'include expired scanner lower boundary: > to >=', original: 'pick.timer_expires_at > p_now', mutated: 'pick.timer_expires_at >= p_now' },
    { id: 'N13', file: 'private/notif_is_stale.sql', symbol: 'private.notif_is_stale(text,jsonb)', operator: 'reverse expired-deadline stale predicate: <= to >=', original: 'deadline <= clock_timestamp()', mutated: 'deadline >= clock_timestamp()' },
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
        const result = oracle(`r2-mutation-${mutant.id}`)
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
const restored = oracle('r2-mutation-restored')
appendFileSync(path.join(evidence, 'commands.jsonl'), `${JSON.stringify(restored)}\n`)
if (restored.exit !== 0) throw new Error('Restored baseline failed')
