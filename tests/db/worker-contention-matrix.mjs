import { randomUUID } from 'node:crypto'
import { hold, liveFixture, must, quote, report, sql } from './worker-harness.mjs'

const FOREGROUND_LOCK_TIMEOUT = '5ms'
const FORECAST_QUEUE_FIX = 'live scoring must not upsert private.matchup_forecast_queue. Queue forecasts only when lineup, roster or score inputs change, in private.queue_changed_matchup_forecasts. History: 4cb9be93 removed game and stat topics from the forecast queue trigger; 32e76a43 only shortened the injury hold.'

const live = (build) => ({ setup: liveFixture, ...build })

const queue = (build) => ({
  setup() {
    const prefix = `matrix-${randomUUID()}`
    return { prefix, cleanup: () => sql(`DELETE FROM private.work_items WHERE key LIKE ${quote(`${prefix}%`)}`) }
  },
  ...build,
})

const cases = [
  live({
    name: 'live stat save while the injury worker holds a player row',
    holds: (f) => [`UPDATE public.players SET injury_status='Out' WHERE id=${quote(f.players[0])}`],
    run: (f) => `SELECT public.save_live_game_stats_atomic(${quote(f.ids.game)},${quote(f.provider)},${f.stats(11)}::jsonb,400)`,
    fix: {
      players: 'a points-only stat change must not lock public.players. Recount careers in private.recount_changed_player_careers only when an appearance or player-game identity changes. History: 32e76a43 fixed this after production live-poll lock timeouts.',
      matchup_forecast_queue: FORECAST_QUEUE_FIX,
    },
  }),
  live({
    name: 'live scoreboard save while an injury identity link is open',
    holds: (f) => [`SELECT public.link_player_sources_atomic('espn',${quote(JSON.stringify([{ provider_id: String(88000001), display_name: `Lock ${f.players[1]}`, nba_team: 'BOS', position: 'PG' }]))}::jsonb)`],
    run: (f) => `SELECT public.save_live_scoreboard_atomic(${quote(f.ids.game)},${quote(f.provider)},'InProgress',12,10,'Q1',400)`,
    fix: { matchup_forecast_queue: FORECAST_QUEUE_FIX },
  }),
  queue({
    name: 'duplicate work_enqueue while a lease update holds the active item',
    before: (f) => `INSERT INTO private.work_items(kind,key,status,lease_token,invocation_key,lease_until,payload)
      VALUES('process-trades',${quote(`${f.prefix}-running`)},'running',gen_random_uuid(),gen_random_uuid(),clock_timestamp()+interval '5 minutes',jsonb_build_object('test',${quote(f.prefix)}))`,
    holds: (f) => [`UPDATE private.work_items SET lease_until=clock_timestamp()+interval '5 minutes' WHERE key=${quote(`${f.prefix}-running`)}`],
    run: (f) => `SELECT coalesce(private.work_enqueue('process-trades',${quote(`${f.prefix}-duplicate`)},clock_timestamp(),jsonb_build_object('test',${quote(f.prefix)}))::text,'skipped')`,
    expect: 'skipped',
    fix: 'private.work_enqueue must return before INSERT ... ON CONFLICT when an active item has the same identity, so a duplicate never waits on a held lease row. History: 065807e6 fixed this after the 2026-10-28 dispatch stalls.',
  }),
  queue({
    name: 'overlapping dispatch_work while another dispatcher holds its lock',
    before: (f) => `SELECT private.work_enqueue('sync-players',${quote(`${f.prefix}-due-`)}||n,clock_timestamp()-interval '1 day',jsonb_build_object('test',${quote(f.prefix)},'slot',n)) FROM generate_series(1,3) n`,
    holds: () => ["SELECT pg_advisory_xact_lock(hashtextextended('public.dispatch_work',0))"],
    run: () => 'SELECT public.dispatch_work()',
    expect: '0',
    within: 500,
    fix: 'public.dispatch_work must take its advisory lock with pg_try_advisory_xact_lock and return 0 when another dispatcher holds it. History: c6874602 added the try-lock with the worker pause control.',
  }),
  queue({
    name: 'scheduled dispatch while workers renew leases and the network queue is locked',
    before: (f) => `INSERT INTO private.work_items(kind,key,status,lease_token,invocation_key,lease_until,payload)
      SELECT 'process-trades',${quote(`${f.prefix}-running-`)}||n,'running',gen_random_uuid(),gen_random_uuid(),clock_timestamp()+interval '5 minutes',jsonb_build_object('test',${quote(f.prefix)},'slot',n) FROM generate_series(1,4) n;
      SELECT private.work_enqueue('sync-players',${quote(`${f.prefix}-pending-`)}||n,clock_timestamp()-interval '1 day',jsonb_build_object('test',${quote(f.prefix)},'slot',n)) FROM generate_series(1,24) n`,
    holds: (f) => [
      `UPDATE private.work_items SET lease_until=clock_timestamp()+interval '5 minutes' WHERE key LIKE ${quote(`${f.prefix}-running-%`)}`,
      'LOCK TABLE net.http_request_queue IN SHARE MODE',
    ],
    run: () => `SET app.supabase_url='http://127.0.0.1:1'; SET app.edge_internal_token='local-contention-test'; ${must("SELECT command FROM cron.job WHERE jobname='work-dispatcher'")}`,
    lockTimeout: null,
    within: 5000,
    after: (f) => `SELECT jsonb_build_object(
      'running',count(*) FILTER(WHERE key LIKE ${quote(`${f.prefix}-running-%`)} AND status='running'),
      'pending',count(*) FILTER(WHERE key LIKE ${quote(`${f.prefix}-pending-%`)} AND status='pending'),
      'lockTimeouts',count(*) FILTER(WHERE key LIKE ${quote(`${f.prefix}-pending-%`)} AND last_error ILIKE '%lock timeout%'))
      FROM private.work_items`,
    expectAfter: '{"pending": 24, "running": 4, "lockTimeouts": 0}',
    fix: 'a saturated dispatcher must stop claiming network work within its 5 s cron budget and leave pending items pending. Keep the running cap in private.work_claim and the loop limit in public.dispatch_work at 4. History: f1c1f6ec lowered both from 8.',
  }),
]

const busy = must("SELECT count(*) FROM private.work_items WHERE status='running' AND lease_until>clock_timestamp()")
if (busy !== '0') {
  console.error('Run the matrix on an idle disposable stack: work items are running.')
  process.exit(2)
}

const lockReason = (error) => {
  const context = error.split('\n').filter((line) => /^(CONTEXT|PL\/pgSQL function|SQL statement)/.test(line.trim()))
  return `${error.split('\n')[0]}${context.length ? ` (${context.slice(0, 3).map((line) => line.trim()).join('; ')})` : ''}`
}

const fixFor = (entry, detail) => typeof entry.fix === 'string' ? entry.fix
  : entry.fix[detail.match(/relation "([^"]+)"/)?.[1]] ?? Object.values(entry.fix).join(' Or: ')

const results = []
for (const entry of cases) {
  let fixture
  const releases = []
  try {
    fixture = entry.setup()
    if (entry.before) must(entry.before(fixture))
    for (const statement of entry.holds(fixture)) releases.push(await hold(statement))
    const timeout = entry.lockTimeout === undefined ? FOREGROUND_LOCK_TIMEOUT : entry.lockTimeout
    const result = sql(`SET statement_timeout='3s';${timeout ? ` SET lock_timeout='${timeout}';` : ''}\n${entry.run(fixture)}`, { timeout: 15000 })
    const within = entry.within ?? 3000
    const after = entry.after ? must(entry.after(fixture)) : null
    const ok = result.ok && result.ms < within && (entry.expect === undefined || result.out.split('\n').at(-1) === entry.expect)
      && (after === null || after === entry.expectAfter)
    const detail = !result.ok ? lockReason(result.err)
      : result.ms >= within ? `took ${Math.round(result.ms)} ms, over ${within} ms`
        : entry.expect !== undefined && result.out.split('\n').at(-1) !== entry.expect ? `returned ${result.out}, expected ${entry.expect}`
          : after !== entry.expectAfter && after !== null ? `left ${after}, expected ${entry.expectAfter}`
            : `finished in ${Math.round(result.ms)} ms${timeout ? ` at lock_timeout ${timeout}` : ''}`
    results.push({ name: entry.name, ok, detail, fix: fixFor(entry, detail) })
  } catch (error) {
    results.push({ name: entry.name, ok: false, detail: `setup failed: ${error.message.split('\n')[0]}`, fix: fixFor(entry, '') })
  } finally {
    for (const release of releases.reverse()) await release()
    fixture?.cleanup()
  }
}
process.exit(report(results))
