import assert from 'node:assert/strict'
import test from 'node:test'
import { productionJobs } from '../../scripts/season-sim/cron.mjs'

test('the direct hint drain sets its limits before either helper executes', () => {
  const job = productionJobs.find(row => row.jobname === 'io-hint-drain')
  assert.equal(job?.schedule, '* * * * *')
  assert.match(job.command, /^SET statement_timeout='5s'; SET lock_timeout='250ms';/)
  const guard = job.command.indexOf("pg_try_advisory_lock(hashtext('io-hint-drain'))")
  assert.ok(guard >= 0 && guard < job.command.indexOf('private.flush_player_stats_hints()'))
  assert.ok(guard < job.command.indexOf('private.flush_league_inventory_hints(1000)'))
  assert.match(job.command, /IF NOT \(SELECT paused FROM private\.worker_controls WHERE id\) THEN/)
  assert.match(job.command, /pg_advisory_unlock\(hashtext\('io-hint-drain'\)\)/)
})

test('the work dispatcher has the matching session overlap guard', () => {
  const job = productionJobs.find(row => row.jobname === 'work-dispatcher')
  assert.equal(job?.schedule, '* * * * *')
  assert.match(job.command, /^SET statement_timeout='5s'; SET lock_timeout='250ms';/)
  assert.match(job.command, /pg_try_advisory_lock\(hashtext\('work-dispatcher'\)\)/)
  assert.match(job.command, /PERFORM public\.dispatch_work\(\)/)
})
