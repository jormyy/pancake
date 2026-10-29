import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { performance } from 'node:perf_hooks'
import { labRoot, project, requireMini } from '../../scripts/perf-lab/common.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'
import { statementDelta } from '../../scripts/perf-lab/database.mjs'
import { nestedPlans } from './forecast-inputs-bound.mjs'

let computeForecast

export const literal = value => `'${String(value).replaceAll("'", "''")}'`

const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] ?? 0

export function summarizeReplay(runs) {
  return runs.map(run => {
    const rate = 60 / run.businessMinutes
    return { round: run.round, phase: run.phase, profile: run.profile, businessMinutes: run.businessMinutes,
      callsPerHour: Object.fromEntries(['invalidation', 'queue', 'enqueue', 'claim', 'prepare', 'prepare-date', 'context', 'complete'].map(kind => [kind, run.samples.filter(row => row.kind === kind).length * rate])),
      forecastDbMsPerHour: run.samples.reduce((sum, row) => sum + row.milliseconds, 0) * rate,
      totalDbMsPerHour: run.stats.filter(row => row.toplevel).reduce((sum, row) => sum + row.total_exec_time, 0) * rate,
      buffersPerHour: run.samples.reduce((sum, row) => sum + row.buffers, 0) * rate,
      p50: percentile(run.completions.map(row => row.milliseconds), 0.5), p95: percentile(run.completions.map(row => row.milliseconds), 0.95),
      matchedP95: null,
    }
  })
}

export function enforceReplay(runs, minimum = 5) {
  assert.equal(new Set(runs.map(row => `${row.round}/${row.phase}/${row.profile}`)).size, runs.length, 'A replay case was counted twice')
  const summary = summarizeReplay(runs)
  for (const profile of ['idle', 'live']) {
    const before = summary.filter(row => row.phase === 'baseline' && row.profile === profile).map(row => row.forecastDbMsPerHour)
    const after = summary.filter(row => row.phase === 'candidate' && row.profile === profile).map(row => row.forecastDbMsPerHour)
    assert.ok(before.length >= minimum && before.length === after.length, 'Five paired runs are required')
    const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
    const noise = Math.max(Math.max(...before) - Math.min(...before), Math.max(...after) - Math.min(...after), mean(before) * 0.1)
    assert.ok(mean(before) - mean(after) > noise, `The ${profile} DB gain is within noise`)
  }
  for (const candidate of runs.filter(row => row.phase === 'candidate' && row.profile === 'live')) {
    const baseline = runs.find(row => row.phase === 'baseline' && row.profile === 'live' && row.round === candidate.round)
    const expected = new Map(baseline.completions.map(row => [`${row.tick}/${row.id}`, row]))
    const seen = new Set(), before = [], after = []
    for (const completion of candidate.completions) {
      const key = `${completion.tick}/${completion.id}`
      assert.ok(!seen.has(key), 'A matchup computed twice in one tick')
      seen.add(key)
      const original = expected.get(key)
      assert.ok(original, `The baseline did not finish ${key}`)
      assert.equal(completion.forecastHash, original.forecastHash, `Live forecast parity: ${key}`)
      before.push(original.milliseconds)
      after.push(completion.milliseconds)
    }
    assert.ok(after.length, 'The live window must publish forecasts')
    assert.ok(percentile(after, 0.95) <= percentile(before, 0.95), 'Live due-to-done p95 regressed')
    summary.find(row => row.round === candidate.round && row.profile === 'live' && row.phase === 'baseline').matchedP95 = percentile(before, 0.95)
    summary.find(row => row.round === candidate.round && row.profile === 'live' && row.phase === 'candidate').matchedP95 = percentile(after, 0.95)
  }
  return summary
}

class Database {
  constructor() {
    this.pending = null
    this.stderr = ''
    this.process = spawn('psql', ['postgresql://supabase_admin:postgres@127.0.0.1:62922/postgres', '-XqAtv', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
    createInterface({ input: this.process.stdout }).on('line', line => {
      if (!this.pending) return
      if (line === this.pending.marker) {
        const { resolve, lines } = this.pending
        this.pending = null
        resolve(lines.join('\n'))
      } else this.pending.lines.push(line)
    })
    this.process.stderr.on('data', chunk => { this.stderr += chunk })
    this.process.on('exit', code => this.pending?.reject(new Error(`psql exited ${code}: ${this.stderr.slice(-8000)}`)))
  }

  async query(statement) {
    assert.equal(this.pending, null)
    return await new Promise((resolve, reject) => {
      const marker = randomUUID()
      this.pending = { marker, resolve, reject, lines: [] }
      this.process.stdin.write(`${statement}\n\\echo ${marker}\n`)
    })
  }

  async json(statement) {
    return JSON.parse(await this.query(statement))
  }

  close() {
    this.process.stdin.end()
  }
}

async function measure(db, expression, kind, samples) {
  const plan = (await db.json(`EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) INSERT INTO forecast_result SELECT COALESCE(to_jsonb(${expression}),'null'::jsonb);`))[0]
  samples.push({ kind, milliseconds: plan['Execution Time'], buffers: (plan.Plan['Shared Hit Blocks'] ?? 0) + (plan.Plan['Shared Read Blocks'] ?? 0) })
  return await db.json('DELETE FROM forecast_result RETURNING value;')
}

async function measureStatement(db, statement, kind, samples) {
  const plan = (await db.json(`EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) ${statement};`))[0]
  samples.push({ kind, milliseconds: plan['Execution Time'], buffers: (plan.Plan['Shared Hit Blocks'] ?? 0) + (plan.Plan['Shared Read Blocks'] ?? 0) })
}

async function prepare(db, id, samples) {
  const dates = await measure(db, `public.prepare_matchup_forecast_inputs(${literal(id)})`, 'prepare', samples)
  for (const date of dates) await measure(db, `public.prepare_matchup_forecast_inputs(${literal(id)},${literal(date)})`, 'prepare-date', samples)
}

async function definitions(base, files) {
  const baseline = [], candidate = []
  for (const file of files) {
    candidate.push(await readFile(`supabase/sql/functions/by-name/${file}.sql`, 'utf8'))
    const original = await command('git', ['show', `${base}:supabase/sql/functions/by-name/${file}.sql`], { allowFailure: true })
    if (original.code === 0) baseline.push(original.stdout)
  }
  return { baseline: baseline.join('\n'), candidate: candidate.join('\n') }
}

async function clock(db, value, extra = []) {
  await db.query(`SELECT set_config('forecast_bench.clock',${literal(value)},true);
DO $$ DECLARE f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.prepare_matchup_forecast_inputs(uuid,date)'::regprocedure,
    'public.get_prepared_matchup_forecast_context(uuid)'::regprocedure,
    'public.get_league_projection_rows(uuid,integer,date,text,uuid[],integer,integer)'::regprocedure,
    'private.matchup_forecast_inputs_ready(uuid)'::regprocedure,
    'private.read_matchup_forecast_context(uuid)'::regprocedure,
    'private.queue_matchup_forecasts(uuid,uuid)'::regprocedure,
    'private.queue_changed_matchup_forecasts()'::regprocedure,
    'private.enqueue_matchup_forecasts(timestamp with time zone)'::regprocedure,
    'public.claim_matchup_forecasts(integer)'::regprocedure,
    'public.complete_matchup_forecast(uuid,bigint,uuid,jsonb,timestamptz)'::regprocedure,
    'private.invalidate_forecast_inputs()'::regprocedure
    ${extra.map(name => `,${literal(name)}::regprocedure`).join('')}
  ] LOOP
    EXECUTE replace(replace(pg_get_functiondef(f),'now()','(current_setting(''forecast_bench.clock'')::timestamptz)'),
      'transaction_timestamp()','(current_setting(''forecast_bench.clock'')::timestamptz)');
  END LOOP;
END $$;`)
}

async function worker(db, samples, due) {
  const claims = await measure(db, '(SELECT COALESCE(jsonb_agg(c),\'[]\'::jsonb) FROM public.claim_matchup_forecasts(10) c)', 'claim', samples)
  const finished = []
  for (const claim of claims) {
    await prepare(db, claim.matchup_id, samples)
    const context = await measure(db, `public.get_prepared_matchup_forecast_context(${literal(claim.matchup_id)})`, 'context', samples)
    const forecast = computeForecast(context)
    const saved = await measure(db, `public.complete_matchup_forecast(${literal(claim.matchup_id)},${claim.revision},${literal(claim.claim_token)},${literal(JSON.stringify(forecast))}::jsonb,${literal(new Date(Date.parse(context.observedAt) + 6 * 3600000).toISOString())})`, 'complete', samples)
    assert.equal(saved, true)
    finished.push({ id: claim.matchup_id, milliseconds: performance.now() - due, forecastHash: createHash('sha256').update(JSON.stringify(forecast)).digest('hex') })
  }
  return finished
}

async function drain(db, samples, due) {
  const completed = []
  for (let attempt = 0; attempt < 10; attempt++) {
    const batch = await worker(db, samples, due)
    completed.push(...batch)
    if (batch.length < 10) return completed
  }
  throw new Error('The forecast queue did not drain')
}

async function replay(db, versions, count, ticks, helper, forced, idleTicks, checkpoint, completed = []) {
  const runs = [...completed]
  for (let round = 0; round < count; round++) {
    for (const phase of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      for (const profile of ['idle', 'live']) {
        if (runs.some(row => row.round === round && row.phase === phase && row.profile === profile)) continue
        const start = profile === 'idle' ? '2026-10-29T20:30:00Z' : '2026-10-28T23:00:00Z'
        await db.query(`BEGIN; SET LOCAL statement_timeout='30s'; ${versions[phase]}`)
        await clock(db, start, helper)
        await db.query(`DELETE FROM private.matchup_forecast_queue;
          TRUNCATE private.forecast_player_history,private.forecast_season_points,private.forecast_projection_inputs;
          UPDATE public.nba_games SET status='InProgress',started_at=game_time,live_stats_elapsed_seconds=600
            WHERE ${profile === 'live' ? 'true' : 'false'} AND game_date='2026-10-28' AND game_time<=${literal(start)}::timestamptz AND status='Scheduled';
          INSERT INTO public.player_game_stats(player_id,game_id,game_date,season_year,points)
          SELECT r.player_id,g.id,g.game_date,g.season_year,1 FROM public.roster_players r JOIN public.players p ON p.id=r.player_id
            JOIN public.nba_games g ON (g.home_team=p.nba_team OR g.away_team=p.nba_team)
          WHERE g.status='InProgress' AND g.game_date='2026-10-28' AND ${profile === 'live' ? 'true' : 'false'}
          ON CONFLICT(player_id,game_id) DO UPDATE SET points=1;
          SELECT private.queue_matchup_forecasts();`)
        const warmup = await drain(db, [], performance.now())
        const source = profile === 'live' ? await db.json(`SELECT to_jsonb(s.id) FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id
          JOIN public.roster_players r ON r.player_id=s.player_id JOIN public.matchups m ON m.league_season_id=r.league_season_id
            AND r.member_id IN(m.home_member_id,m.away_member_id)
          WHERE left(m.id::text,8)='e47fcb99' AND g.status='InProgress' AND g.game_date='2026-10-28' ORDER BY s.player_id,s.game_id LIMIT 1;`) : null
        if (profile === 'live') assert.ok(source)
        const snapshot = () => db.json(`SELECT COALESCE(jsonb_agg(s),'[]'::jsonb) FROM (
          SELECT queryid::text,userid::text,dbid::text,toplevel,query,calls,rows,total_exec_time,
            shared_blks_hit,shared_blks_read,shared_blks_dirtied,shared_blks_written,temp_blks_read,temp_blks_written,wal_bytes::text
          FROM extensions.pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%' ORDER BY total_exec_time DESC
        ) s;`)
        const before = await snapshot()
        const samples = [], completions = []
        const measuredTicks = profile === 'idle' ? idleTicks : ticks
        const step = profile === 'idle' ? 3600000 / idleTicks : 30000
        for (let tick = 1; tick <= measuredTicks; tick++) {
          const observed = new Date(Date.parse(start) + tick * step).toISOString()
          await db.query(`SELECT set_config('forecast_bench.clock',${literal(observed)},true);`)
          const due = performance.now()
          if (profile === 'live') {
            await db.query(`UPDATE public.nba_games SET live_stats_elapsed_seconds=600+${tick * 30} WHERE game_date='2026-10-28' AND status='InProgress';
              UPDATE public.player_game_stats SET points=points+${tick % 2} WHERE id=${literal(source)};
              UPDATE public.matchups m SET home_points=m.home_points+${tick % 2}
              FROM public.league_seasons s,public.season_weeks w,public.season_weeks e,public.player_game_stats stat
              WHERE m.league_season_id=s.id AND w.season_year=s.season_year AND w.week_number=m.week_number
                AND e.season_year=s.season_year AND e.week_number=COALESCE(m.end_week_number,m.week_number)
                AND stat.id=${literal(source)} AND stat.game_date BETWEEN w.week_start AND e.week_end
                AND ${tick % 2}=1 AND NOT m.is_voided AND EXISTS(SELECT 1 FROM public.roster_players r
                  WHERE r.league_season_id=m.league_season_id AND r.member_id IN(m.home_member_id,m.away_member_id) AND r.player_id=stat.player_id);`)
          }
          if (forced) {
            await db.query('UPDATE analytics.search_cache_refresh_state SET refreshed_at=clock_timestamp();')
            await measure(db, 'private.queue_matchup_forecasts()', 'queue', samples)
          } else if (profile === 'live' || (tick - 1) % 9 === 0) {
            await measureStatement(db, 'UPDATE analytics.search_cache_refresh_state SET refreshed_at=clock_timestamp()', 'invalidation', samples)
          } else await measureStatement(db, `UPDATE public.league_change_hints SET revision=revision+1,details=NULL,updated_at=clock_timestamp() WHERE topic='resources'`, 'invalidation', samples)
          await measure(db, "private.enqueue_matchup_forecasts(current_setting('forecast_bench.clock')::timestamptz)", 'enqueue', samples)
          completions.push(...(await drain(db, samples, due)).map(row => ({ ...row, tick })))
          if (tick % 15 === 0) console.log(`Replay ${round + 1}/${count} ${phase} ${profile}: ${tick}/${measuredTicks} ticks`)
        }
        const stats = statementDelta(before, await snapshot())
        runs.push({ round, phase, profile, businessMinutes: measuredTicks * step / 60000, samples, completions, warmup, stats })
        await db.query('ROLLBACK;')
        await checkpoint(runs)
        console.log(`Replay round ${round + 1}/${count}: ${phase} ${profile}, ${completions.length} forecasts`)
      }
    }
  }
  return { runs }
}

async function preparation(db, versions, count) {
  const runs = [], parity = new Map()
  for (let round = 0; round < count; round++) {
    for (const phase of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      for (const observed of ['2026-10-27T20:30:00Z', '2026-10-28T23:00:00Z']) {
        await db.query(`BEGIN; SET LOCAL statement_timeout='30s'; ${versions[phase]}`)
        await clock(db, observed)
        await db.query(`UPDATE public.nba_games SET status='InProgress',started_at=game_time,live_stats_elapsed_seconds=600
          WHERE game_date='2026-10-28' AND game_time<=${literal(observed)}::timestamptz AND status='Scheduled';`)
        const matchups = await db.json(`SELECT jsonb_agg(m.id ORDER BY m.id) FROM public.matchups m WHERE left(m.id::text,8) IN('07ad4dd3','ccb35830','e47fcb99');`)
        assert.equal(matchups.length, 3)
        for (const id of matchups) {
          await db.query('TRUNCATE private.forecast_player_history,private.forecast_season_points,private.forecast_projection_inputs;')
          for (const state of ['cold', 'warm']) {
            const samples = []
            await prepare(db, id, samples)
            const context = await db.json(`SELECT public.get_prepared_matchup_forecast_context(${literal(id)});`)
            const forecast = computeForecast(context)
            const key = `${observed}/${id}/${state}`
            const value = JSON.stringify({ context, forecast })
            if (parity.has(key)) assert.equal(value, parity.get(key), `Forecast parity: ${key}`)
            else parity.set(key, value)
            runs.push({ round, phase, observed, id, state, samples, milliseconds: samples.reduce((sum, row) => sum + row.milliseconds, 0), calls: samples.length })
          }
        }
        await db.query('ROLLBACK;')
      }
      console.log(`Preparation round ${round + 1}/${count}: ${phase}`)
    }
  }
  return { runs, parityPairs: parity.size, plans: nestedPlans(db.stderr) }
}

async function parity(db, versions) {
  const expected = new Map(), rows = [], clocks = []
  for (const phase of ['baseline', 'candidate']) {
    for (const observed of ['2026-11-03T20:30:00Z', '2026-10-28T23:00:00Z']) {
      await db.query(`BEGIN; SET LOCAL statement_timeout='30s'; ${versions[phase]}`)
      await clock(db, observed, ['private.matchup_forecast_input_fingerprint(uuid)'])
      await db.query(`TRUNCATE private.forecast_player_history,private.forecast_season_points,private.forecast_projection_inputs;
        UPDATE public.nba_games SET status='InProgress',started_at=game_time,live_stats_elapsed_seconds=600
        WHERE game_date='2026-10-28' AND ${literal(observed.slice(0, 10))}::date=game_date
          AND game_time<=${literal(observed)}::timestamptz AND status='Scheduled';`)
      const calendar = await db.json(`SELECT jsonb_build_object('games',count(*),'live',count(*) FILTER(WHERE status='InProgress'),
        'allLive',(SELECT count(*) FROM public.nba_games WHERE status='InProgress'))
        FROM public.nba_games WHERE game_date=${literal(observed.slice(0, 10))}::date AND public.is_regular_season_game_id(nba_game_id);`)
      if (observed.startsWith('2026-11-03')) {
        assert.equal(calendar.games, 0, 'The off day must have no NBA games')
        assert.equal(calendar.allLive, 0, 'The off day must have no live games')
      }
      else assert.ok(calendar.live > 0, 'The live day must contain a live game')
      clocks.push({ phase, observed, ...calendar })
      const matchups = await db.json('SELECT jsonb_agg(id ORDER BY id) FROM public.matchups;')
      for (const id of matchups) {
        await prepare(db, id, [])
        const key = `${observed}/${id}`
        const available = await db.json(`SELECT to_jsonb(private.read_matchup_forecast_context(${literal(id)}) IS NOT NULL);`)
        if (!available) {
          if (phase === 'baseline') expected.set(key, null)
          else assert.equal(expected.get(key), null, `Forecast availability parity: ${key}`)
          rows.push({ phase, observed, id, unavailable: true })
          continue
        }
        const context = await db.json(`SELECT public.get_prepared_matchup_forecast_context(${literal(id)});`)
        const value = JSON.stringify({ context, forecast: computeForecast(context) })
        if (phase === 'baseline') expected.set(key, value)
        else assert.equal(value, expected.get(key), `Exact context and forecast parity: ${key}`)
        rows.push({ phase, observed, id, hash: createHash('sha256').update(value).digest('hex') })
      }
      await db.query('ROLLBACK;')
      console.log(`All-matchup parity: ${phase} ${observed}, ${matchups.length} matchups`)
    }
  }
  return { rows, clocks, parityPairs: expected.size, availablePairs: rows.filter(row => row.phase === 'candidate' && !row.unavailable).length }
}

async function main() {
  await requireMini()
  assert.equal(project, 'pt4bafablefo')
  computeForecast = (await import(new URL('../../supabase/functions/matchup-forecast/compute.ts', import.meta.url).href)).computeForecast
  const { values } = parseArgs({ options: { round: { type: 'string', default: 'prepare' }, base: { type: 'string', default: 'ec739102' }, samples: { type: 'string', default: '5' }, ticks: { type: 'string', default: '60' }, 'idle-ticks': { type: 'string', default: '27' }, output: { type: 'string', default: 'forecast-prepare.json' }, 'force-invalidation': { type: 'boolean', default: false }, resume: { type: 'boolean', default: false } } })
  assert.match(values.output, /^[a-z0-9-]+\.json$/)
  assert.ok(['prepare', 'replay', 'parity'].includes(values.round))
  const settings = await command('docker', ['inspect', `supabase_db_${project}`, '--format', '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}'])
  assert.equal(settings.stdout.trim(), '250000000 1073741824')
  const files = ['public/prepare_matchup_forecast_inputs', ...(values.round !== 'prepare' ? [
    'private/matchup_forecast_input_fingerprint', 'private/queue_matchup_forecasts', 'private/queue_changed_matchup_forecasts', 'private/enqueue_matchup_forecasts',
    'private/invalidate_forecast_inputs', 'public/claim_matchup_forecasts', 'public/complete_matchup_forecast',
  ] : [])]
  const versions = await definitions(values.base, files)
  const identity = { base: values.base, baselineDigest: createHash('sha256').update(versions.baseline).digest('hex'),
    candidateDigest: createHash('sha256').update(versions.candidate).digest('hex'), forcedInvalidation: values['force-invalidation'],
    ticks: Number(values.ticks), idleTicks: Number(values['idle-ticks']), protocol: 'resource-pulses-v1' }
  const partialPath = path.join(labRoot, values.output.replace(/\.json$/, '-partial.json'))
  const previous = values.resume ? JSON.parse(await readFile(partialPath, 'utf8')) : { runs: [] }
  if (values.resume) {
    assert.equal(values.round, 'replay')
    assert.deepEqual(previous.identity, identity, 'Resume requires identical function sources and protocol')
    assert.equal(new Set(previous.runs.map(row => `${row.round}/${row.phase}/${row.profile}`)).size, previous.runs.length)
    for (const row of previous.runs) {
      assert.ok(Number.isInteger(row.round) && row.round >= 0 && row.round < Number(values.samples))
      assert.ok(['baseline', 'candidate'].includes(row.phase) && ['idle', 'live'].includes(row.profile))
      assert.ok(Math.abs(row.businessMinutes - (row.profile === 'idle' ? 60 : Number(values.ticks) / 2)) < 0.000001)
    }
    console.log(`Resuming ${previous.runs.length} completed replay cases.`)
  }
  const db = new Database()
  try {
    await db.query('CREATE TEMP TABLE forecast_result(value jsonb);')
    const result = values.round === 'prepare' ? await preparation(db, versions, Number(values.samples))
      : values.round === 'parity' ? await parity(db, versions)
        : await replay(db, versions, Number(values.samples), Number(values.ticks), ['private.matchup_forecast_input_fingerprint(uuid)'], values['force-invalidation'], Number(values['idle-ticks']),
          runs => writeFile(partialPath, `${JSON.stringify({ runs, identity })}\n`, { mode: 0o600 }), previous.runs)
    const report = { ...result, cpu: 0.25, memory: 1073741824, base: values.base, forcedInvalidation: values['force-invalidation'],
      baselineDigest: createHash('sha256').update(versions.baseline).digest('hex'), candidateDigest: createHash('sha256').update(versions.candidate).digest('hex') }
    await writeFile(path.join(labRoot, values.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    if (values.round === 'replay' && Number(values.samples) >= 5) {
      const summary = enforceReplay(result.runs)
      await writeFile(path.join(labRoot, values.output.replace(/\.json$/, '-summary.json')), `${JSON.stringify({ cpu: report.cpu, memory: report.memory,
        base: report.base, baselineDigest: report.baselineDigest, candidateDigest: report.candidateDigest, forcedInvalidation: report.forcedInvalidation, summary }, null, 2)}\n`, { mode: 0o600 })
    }
  } finally { db.close() }
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main()
