import assert from 'node:assert/strict'

export const productionJobs = [
  ['nba-live-poll', '*/2 * * * *', 'SELECT public.invoke_live_poll_if_due()'],
  ['season-boundary', '*/15 * * * *', 'SELECT public.invoke_season_boundary_if_due()'],
  ['nba-process-trades', '*/5 * * * *', 'SELECT public.invoke_process_trades_if_due()'],
  ['nba-close-expired-nominations', '* * * * *', 'SELECT public.invoke_close_expired_nominations_if_due()'],
  ['nba-dispatch-stats-sync-jobs', '* * * * *', 'SELECT public.invoke_stats_sync_dispatch_if_due()'],
  ['nba-lineup-optimizer', '* * * * *', 'SELECT public.invoke_pre_tipoff_optimizer_if_due()'],
  ['nba-sync-players', '*/15 * * * *', "SELECT public.invoke_edge_function_at_et_time('sync-players',6,0)"],
  ['nba-sync-schedule', '5,20,35,50 * * * *', "SELECT public.invoke_edge_function_at_et_time('sync-schedule',6,5)"],
  ['nba-process-waivers', '*/15 * * * *', "SELECT public.invoke_edge_function_at_et_time('process-waivers',3,0)"],
  ['nba-sync-projections', '0 12-23 * * *', 'SELECT public.invoke_projection_sync_if_due()'],
  ['nba-sync-rankings', '0 * * * *', 'SELECT public.invoke_dynasty_ranking_views_at_et_time(7,0)'],
  ['nba-sync-draft-order-june', '0 13 20-30 6 *', "SELECT public.invoke_edge_function('sync-draft-order')"],
  ['nba-sync-draft-order-july', '0 13 1-15 7 *', "SELECT public.invoke_edge_function('sync-draft-order')"],
  ['edge-invocation-reconcile', '*/5 * * * *', 'SELECT private.reconcile_edge_invocations()'],
].map(([jobname, schedule, command]) => ({ jobname, schedule, command }))

function fieldMatches(field, value, maximum) {
  return field.split(',').some(part => {
    const [range, stride = '1'] = part.split('/')
    const [start, end] = range === '*' ? [0, maximum] : range.split('-').map(Number)
    return value >= start && value <= (end ?? start) && (value - start) % Number(stride) === 0
  })
}

export function cronMatches(schedule, instant) {
  const fields = schedule.split(' ')
  assert.equal(fields.length, 5, `Unsupported cron schedule: ${schedule}`)
  const date = new Date(instant)
  const values = [date.getUTCMinutes(), date.getUTCHours(), date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCDay()]
  return fields.every((field, index) => fieldMatches(field, values[index], [59, 23, 31, 12, 7][index]))
}

export function verifyCronCatalog(catalog) {
  for (const job of productionJobs) {
    const actual = catalog.find(row => row.jobname === job.jobname)
    assert.ok(actual, `Missing production cron job: ${job.jobname}`)
    assert.equal(actual.schedule, job.schedule, `Changed production cadence: ${job.jobname}`)
    const normalize = value => value.replace(/\bpublic\./g, '').replace(/[\s;]/g, '').toLowerCase()
    assert.equal(normalize(actual.command), normalize(job.command), `Changed production command: ${job.jobname}`)
  }
  return true
}

export function cronCommands(instant) {
  return productionJobs.filter(job => cronMatches(job.schedule, instant))
}

export async function advanceCron({ from, to, move, invoke, sample = async (..._args) => {}, counts = {}, settle = null, profile = null }) {
  assert.ok(Number.isFinite(from) && Number.isFinite(to) && to >= from, 'Cron time cannot move backwards')
  if (settle) {
    let at = from
    let state = await settle(at)
    while (at < to) {
      const began = performance.now()
      const minute = (Math.floor(at / 60000) + 1) * 60000
      const wake = state.nextAt == null ? Infinity : state.nextAt
      assert.ok(wake > at, 'Worker timer must settle before advancing the clock')
      at = Math.min(to, minute, wake)
      await move(at, at)
      const jobs = at % 60000 === 0 ? cronCommands(at) : []
      if (jobs.length) {
        await invoke(jobs.map(job => job.command).join('; '), { optional: true, defer: true })
        for (const job of jobs) counts[job.jobname] = (counts[job.jobname] ?? 0) + 1
      }
      state = await settle(at)
      if (jobs.length) await sample(at, jobs)
      await profile?.({ at, wallSeconds: (performance.now() - began) / 1000, minute: at % 60000 === 0 })
    }
    await move(to, to)
    return counts
  }
  for (let at = (Math.floor(from / 60000) + 1) * 60000; at <= to; at += 60000) {
    await move(at, Math.min(to, at + 60000))
    const jobs = cronCommands(at)
    await invoke(jobs.map(job => job.command).join('; '), { optional: true })
    for (const job of jobs) counts[job.jobname] = (counts[job.jobname] ?? 0) + 1
    await sample(at, jobs)
  }
  await move(to, to)
  return counts
}

export function mergeCronCatalog(installed, retained = []) {
  const rows = [...new Map([...retained, ...installed].map(row => [row.jobname, row])).values()].sort((a, b) => a.jobname.localeCompare(b.jobname))
  verifyCronCatalog(rows)
  return rows
}
