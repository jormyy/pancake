import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { productionJobs, verifyCronCatalog } from './cron.mjs'
import { installedCronJobs } from './migration-cron.mjs'

test('cron replay follows ordered migration schedules and removals', () => {
  const jobs = installedCronJobs([
    { name: '002', source: "SELECT cron.unschedule(jobid) FROM cron.job WHERE command ILIKE '%retired%'; SELECT cron.schedule('live','*/15 * * * *',$job$SELECT live()$job$);" },
    { name: '001', source: "SELECT cron.schedule('old','0 * * * *','SELECT retired()'); SELECT cron.schedule('live','* * * * *',$$SELECT old()$$); SELECT cron.schedule('drop','* * * * *','SELECT 1'); SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname IN ('drop');" },
  ])
  assert.deepEqual(jobs, [{ jobname: 'live', schedule: '*/15 * * * *', command: 'SELECT live()' }])
})

test('cron replay accepts compact removal predicates without restoring retired jobs', () => {
  const jobs = installedCronJobs([
    { name: '001', source: "SELECT cron.schedule('nba-process-trades','* * * * *','SELECT process_trades()'); SELECT cron.schedule('drop','* * * * *','SELECT 1'); SELECT cron.schedule('retired','* * * * *','SELECT retired()'); SELECT cron.schedule('live','* * * * *','SELECT live()');" },
    { name: '002', source: "SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname='nba-process-trades'; SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname IN('drop'); SELECT cron.unschedule(jobid) FROM cron.job WHERE command ILIKE'%retired%';" },
  ])
  assert.deepEqual(jobs, [{ jobname: 'live', schedule: '* * * * *', command: 'SELECT live()' }])
})

test('replay jobs match the cron catalog installed by the migrations', async () => {
  const directory = new URL('../../supabase/migrations/', import.meta.url)
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql'))
  const installed = installedCronJobs(await Promise.all(files.map(async name => ({ name, source: await readFile(new URL(name, directory), 'utf8') }))))
  verifyCronCatalog(installed)
  for (const name of ['work-dispatcher']) {
    assert.throws(() => verifyCronCatalog(installed.filter(job => job.jobname !== name)), new RegExp(`Missing production cron job: ${name}`))
    assert.throws(() => verifyCronCatalog(installed.map(job => job.jobname === name ? { ...job, schedule: '0 0 * * *' } : job)), new RegExp(`Changed production cadence: ${name}`))
  }
  assert.deepEqual(installed, productionJobs)
})

test('cron alterations preserve command separators and apply the latest named fields', () => {
  const jobs = installedCronJobs([
    { name: '003', source: "SELECT cron.alter_job(jobid, command := $$SET statement_timeout='5s'; SET lock_timeout='250ms'; SELECT dispatch_work();$$, schedule := '* * * * *') FROM cron.job WHERE jobname='work-dispatcher';" },
    { name: '001', source: "SELECT cron.schedule('work-dispatcher','0 * * * *','SELECT dispatch_work()');" },
    { name: '002', source: "SELECT cron.alter_job(jobid, schedule := '*/2 * * * *') FROM cron.job WHERE jobname='work-dispatcher';" },
    { name: '004', source: "SELECT cron.alter_job(jobid, command := 'SET statement_timeout=''4s''; SELECT dispatch_work();') FROM cron.job WHERE jobname='work-dispatcher';" },
  ])
  assert.deepEqual(jobs, [{ jobname: 'work-dispatcher', schedule: '* * * * *', command: "SET statement_timeout='4s'; SELECT dispatch_work();" }])
})

test('unsupported cron alterations fail instead of keeping an obsolete command', () => {
  assert.throws(() => installedCronJobs([
    { name: '001', source: "SELECT cron.schedule('work-dispatcher','* * * * *','SELECT dispatch_work()');" },
    { name: '002', source: "SELECT cron.alter_job(jobid, command := runtime_command()) FROM cron.job WHERE jobname='work-dispatcher';" },
  ]), /Unsupported cron update in 002/)
})
