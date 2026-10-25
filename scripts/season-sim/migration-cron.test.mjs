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
  const maintenance = new Set(['mock-room-expiry', 'retention-prune', 'pg-net-response-vacuum', 'player-stats-hints', 'league-inventory-hint-drain'])
  assert.deepEqual(installed.filter(job => !maintenance.has(job.jobname)).map(job => job.jobname), productionJobs.map(job => job.jobname).sort())
})
