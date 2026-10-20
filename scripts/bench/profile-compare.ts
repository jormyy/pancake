import { connect } from './request-driver.ts'
import { guardTarget, summarize } from './profile.ts'
import { readWorkloads } from './profile-workloads.ts'

const flags = new Map<string, string>()
for (let index = 0; index < Deno.args.length; index += 2) {
  if (!['--label', '--rounds', '--out', '--before', '--after'].includes(Deno.args[index]) || !Deno.args[index + 1]) throw Error('Use --label NAME --rounds N --out DIR --before DIR --after DIR')
  flags.set(Deno.args[index], Deno.args[index + 1])
}
const label = flags.get('--label') ?? 'comparison'
const rounds = Number(flags.get('--rounds') ?? 5)
if (!/^[a-z0-9_-]+$/i.test(label) || !Number.isInteger(rounds) || rounds < 5) throw Error('Require a safe label and at least five paired rounds')
const db = Deno.env.get('SUPABASE_DB_URL') ?? ''
guardTarget(db, '56322')
guardTarget(Deno.env.get('SUPABASE_URL') ?? '', '56321')
const before = await Deno.realPath(flags.get('--before') ?? '')
const after = await Deno.realPath(flags.get('--after') ?? '')
if (before === after) throw Error('Before and after require separate source copies')
const out = flags.get('--out')
if (!out) throw Error('Require an external evidence directory')
await Deno.mkdir(out, { recursive: true })
const directory = await Deno.realPath(out)
for (const source of [before, after]) {
  if (directory === source || directory.startsWith(source + '/')) throw Error('Keep evidence outside both source copies')
}
const destination = `${directory}/${label}.json`
try { await Deno.stat(destination); throw Error('Evidence already exists') } catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error }
const sql = connect(db)
const observer = connect(db)
const readCases = readWorkloads({ roster: '' }).map(workload => workload.name)
if (readCases.length !== 43) throw Error('Expected all 43 screen read cases')
const cases = [...readCases, 'stale-score-weeks', 'sync-scores-engine-no-provider', 'sync-scores']
const runs: Record<string, unknown>[] = []
const command = ['deno run --no-lock --node-modules-dir=none -A scripts/bench/profile-compare.ts', ...Deno.args].join(' ')
const text = (value: Uint8Array) => new TextDecoder().decode(value)
const hash = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))).map(value => value.toString(16).padStart(2, '0')).join('')
async function captureMachine() {
  const result: Record<string, unknown> = { realAt: new Date().toISOString() }
  for (const [name, executable, args] of [
    ['load', 'sysctl', ['-n', 'vm.loadavg']],
    ['memory', 'vm_stat', []],
    ['disk', 'df', ['-k', directory]],
  ] as const) {
    const output = await new Deno.Command(executable, { args: [...args], stdout: 'piped', stderr: 'piped' }).output()
    result[name] = { code: output.code, stdout: text(output.stdout), stderr: text(output.stderr) }
  }
  return result
}
async function captureState() {
  return (await observer`SELECT
    (SELECT count(*)::int FROM public.players) players,
    (SELECT count(*)::int FROM public.player_game_stats) stats,
    (SELECT count(*)::int FROM public.leagues) leagues,
    (SELECT count(*)::int FROM public.leagues WHERE slug NOT LIKE 'perf-6172026-%') foreignLeagues,
    (SELECT count(*)::int FROM public.roster_players) rosters,
    (SELECT count(*)::int FROM private.score_week_certificates) certificates,
    (SELECT md5(jsonb_agg(jsonb_build_array(id,home_points,away_points,home_max_possible_points,away_max_possible_points,winner_member_id,is_finalized,finalized_at,score_read_started_at) ORDER BY id)::text) FROM public.matchups) matchupDigest,
    (SELECT md5(jsonb_agg(jsonb_build_array(league_id,league_season_id,member_id,week_number,wins,losses,ties,points_for,points_against,max_possible_points,waiver_priority) ORDER BY league_season_id,week_number,member_id)::text) FROM public.standings) standingsDigest,
    (SELECT md5(coalesce(jsonb_agg(jsonb_build_array(dedupe_key,member_id,event_type,title,body,data,category) ORDER BY dedupe_key),'[]'::jsonb)::text) FROM public.notification_outbox) outboxDigest`)[0]
}
const report: Record<string, unknown> = { label, rounds, command, generatedAt: new Date().toISOString(), runs,
  method: 'One warmed deterministic fixture. BEFORE then AFTER in each pair. Separate native Deno processes use identical harness flags and pinned provider responses. Each named workload resets pg_stat_statements. No fixture writes or primes between variants beyond the shared harness setup. All 43 authenticated screen reads run in each variant. Full statement snapshots remain in each run artifact.',
  sources: {}, summary: {} }
const save = () => Deno.writeTextFile(destination, JSON.stringify(report, null, 2) + '\n')
try {
  await observer.unsafe("SET pg_stat_statements.track='none'")
  const initial = await captureState()
  if (initial.players !== 600 || initial.stats !== 49200 || initial.leagues !== 30 || initial.foreignleagues !== 0 || initial.rosters !== 5400 || initial.certificates !== 600) throw Error(`Prime the fixed dataset first: ${JSON.stringify(initial)}`)
  report.dataset = initial
  for (const [variant, root] of [['before', before], ['after', after]] as const) {
    const files: Record<string, string> = {}
    for (const name of ['supabase/shared-src/sync/scores.ts', 'supabase/functions/_shared/syncScores.ts', 'supabase/sql/functions/by-name/public/get_stale_score_weeks.sql', 'scripts/bench/profile.ts', 'scripts/bench/profile-handlers.ts', 'scripts/bench/profile-workloads.ts', 'scripts/bench/profile-seed.sql']) files[name] = await hash(await Deno.readFile(`${root}/${name}`))
    ;(report.sources as Record<string, unknown>)[variant] = { root, files }
  }
  const sources = report.sources as Record<string, { files: Record<string, string> }>
  for (const name of Object.keys(sources.before.files).filter(name => name.startsWith('scripts/bench/'))) {
    if (sources.before.files[name] !== sources.after.files[name]) throw Error(`Harness copies differ: ${name}`)
  }
  await save()
  for (let round = 0; round < rounds; round++) {
    for (const [variant, root] of [['before', before], ['after', after]] as const) {
      const definition = await Deno.readTextFile(`${root}/supabase/sql/functions/by-name/public/get_stale_score_weeks.sql`)
      if (!definition.startsWith('CREATE OR REPLACE FUNCTION public.get_stale_score_weeks(')) throw Error('Unexpected stale-week function source')
      await sql.unsafe(definition)
      const runLabel = `${label}-${round + 1}-${variant}`
      const args = ['run', '--no-lock', '--node-modules-dir=none', '-A', 'scripts/bench/profile.ts', '--label', runLabel,
        '--rounds', '1', '--single-sample', 'true', '--reuse-fixture', 'true', '--prime', 'false', '--phase', 'all', '--jobs', 'all', '--only', cases.join(','), '--out', directory]
      const machineBefore = await captureMachine()
      const stateBefore = await captureState()
      const machineDuring: Record<string, unknown>[] = []
      let sampling: Promise<void> | undefined
      const timer = setInterval(() => {
        if (!sampling) sampling = captureMachine().then(sample => { machineDuring.push(sample) }).finally(() => { sampling = undefined })
      }, 10000)
      const start = performance.now()
      let child: Deno.CommandOutput
      try {
        child = await new Deno.Command(Deno.execPath(), { args, cwd: root, stdout: 'piped', stderr: 'piped' }).output()
      } finally {
        clearInterval(timer)
        await sampling
      }
      await Deno.writeTextFile(`${directory}/${runLabel}.log`, text(child.stdout) + text(child.stderr))
      const elapsedMs = performance.now() - start
      const machineAfter = await captureMachine()
      if (!child.success) throw Error(`${runLabel} exits ${child.code}; inspect its external log`)
      const result = JSON.parse(await Deno.readTextFile(`${directory}/${runLabel}.json`))
      const measurements = result.measurements as Record<string, unknown>[]
      if (measurements.length !== cases.length) throw Error('Missing comparison workloads')
      for (const item of measurements) {
        const samples = item.samples as { error?: string; result?: { status?: number } }[]
        if (samples.length !== 1 || samples[0].error || (samples[0].result?.status ?? 200) >= 400) throw Error(`${runLabel}: ${item.name} fails`)
      }
      const stateAfter = await captureState()
      const unchanged = JSON.stringify(initial) === JSON.stringify(stateAfter) && JSON.stringify(initial) === JSON.stringify(stateBefore)
      runs.push({ round: round + 1, variant, source: root, command: [Deno.execPath(), ...args].join(' '), artifact: `${runLabel}.json`, elapsedMs, machineBefore, machineDuring, machineAfter, stateBefore, stateAfter, unchanged,
        measurements: measurements.map(item => ({ name: item.name, latencyMs: item.latencyMs, dbMs: item.dbMs, samples: item.samples })) })
      await save()
      console.log(JSON.stringify({ round: round + 1, variant, elapsedMs, unchanged }))
      if (!unchanged) throw Error('Scores, standings, outbox, or dataset change between variants')
    }
  }
  report.summary = Object.fromEntries(cases.map(name => [name, Object.fromEntries(['before', 'after'].map(variant => {
    const items = runs.filter(run => run.variant === variant).flatMap(run => (run.measurements as Record<string, unknown>[]).filter(item => item.name === name))
    return [variant, { ms: summarize(items.flatMap(item => (item.samples as { ms: number }[]).map(sample => sample.ms))), dbMs: summarize(items.flatMap(item => (item.samples as { dbMs: number }[]).map(sample => sample.dbMs))) }]
  }))]))
  await save()
  console.log(JSON.stringify(report.summary))
} finally {
  await sql.end()
  await observer.end()
}
