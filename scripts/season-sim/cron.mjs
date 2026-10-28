import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { installedCronJobs } from './migration-cron.mjs'

const migrationDirectory = new URL('../../supabase/migrations/', import.meta.url)
export const productionJobs = installedCronJobs(readdirSync(migrationDirectory)
  .filter(name => /^\d+_.+\.sql$/.test(name))
  .map(name => ({ name, source: readFileSync(new URL(name, migrationDirectory), 'utf8') })))

function fieldMatches(field, value, maximum) {
  return field.split(',').some(part => {
    const [range, stride = '1'] = part.split('/')
    const [start, end] = range === '*' ? [0, maximum] : range.split('-').map(Number)
    return value >= start && value <= (end ?? start) && (value - start) % Number(stride) === 0
  })
}

export function cronMatches(schedule, instant) {
  const interval = /^(\d+) seconds?$/.exec(schedule)
  if (interval) {
    const seconds = Number(interval[1])
    assert.ok(seconds >= 1 && seconds <= 59, `Unsupported cron interval: ${schedule}`)
    return new Date(instant).getTime() % (seconds * 1000) === 0
  }
  const fields = schedule.split(' ')
  assert.equal(fields.length, 5, `Unsupported cron schedule: ${schedule}`)
  if (new Date(instant).getTime() % 60000 !== 0) return false
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

export function cronCommands(instant, catalog = productionJobs) {
  return catalog.filter(job => cronMatches(job.schedule, instant))
}

export function expiryCronTick(expiresAt) {
  const at = Date.parse(expiresAt)
  assert.ok(Number.isFinite(at), 'A real pick expiry is required')
  return (Math.floor(at / 60000) + 1) * 60000
}

export async function advanceCron({ from, to, move, invoke, sample = async (..._args) => {}, counts = {}, settle = null, profile = null, catalog = productionJobs, compression = null }) {
  assert.ok(Number.isFinite(from) && Number.isFinite(to) && to >= from, 'Cron time cannot move backwards')
  for (const job of catalog) cronMatches(job.schedule, from)
  const intervals = catalog.map(job => /^(\d+) seconds?$/.exec(job.schedule)).filter(Boolean).map(match => Number(match[1]) * 1000)
  const nextTick = at => Math.min(...[60000, ...intervals].map(period => (Math.floor(at / period) + 1) * period))
  if (settle) {
    let at = from
    let state = await settle(at)
    compression?.begin()
    await compression?.refresh(at, state)
    while (at < to) {
      const began = performance.now()
      const wake = state.nextAt == null ? Infinity : state.nextAt
      assert.ok(wake > at, 'Worker timer must settle before advancing the clock')
      let next = nextTick(at)
      let jobs = []
      while (next <= Math.min(to, wake)) {
        const due = cronCommands(next, catalog)
        jobs = compression ? compression.select(due, next, state) : due
        if (jobs.length) break
        next = nextTick(next)
      }
      at = Math.min(to, next, wake)
      await move(at, at)
      if (at !== next) jobs = []
      if (jobs.length) {
        await invoke(jobs.map(job => job.command.trim().replace(/;+$/, '')).join('; '), { optional: true, defer: true })
        for (const job of jobs) counts[job.jobname] = (counts[job.jobname] ?? 0) + 1
      }
      state = await settle(at)
      await compression?.refresh(at, state)
      if (jobs.length) await sample(at, jobs)
      await profile?.({ at, wallSeconds: (performance.now() - began) / 1000, minute: at % 60000 === 0 })
    }
    await move(to, to)
    return counts
  }
  for (let at = nextTick(from); at <= to; at = nextTick(at)) {
    await move(at, Math.min(to, nextTick(at)))
    const jobs = cronCommands(at, catalog)
    await invoke(jobs.map(job => job.command.trim().replace(/;+$/, '')).join('; '), { optional: true })
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
