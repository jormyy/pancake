import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { advanceCron, productionJobs, verifyCronCatalog } from '../scripts/season-sim/cron.mjs'

const migration = readFileSync('supabase/migrations/20261114000100_bounded_worker_database_work.sql', 'utf8')
const command = migration.match(/cron\.alter_job\(jobid, command := \$\$([\s\S]*?)\$\$\) FROM cron\.job WHERE jobname='work-dispatcher'/)?.[1]
const installed = productionJobs.map(job => job.jobname==='work-dispatcher' ? { ...job,command } : job)

it('accepts the dispatcher command installed by the timeout migration', () => {
  expect(command).toBeTruthy()
  expect(verifyCronCatalog(installed)).toBe(true)
  expect(productionJobs.find(job => job.jobname === 'work-dispatcher')?.command).toBe(command)
})

it.each([
  "SELECT public.dispatch_work()",
  "SET statement_timeout='50s'; SET lock_timeout='250ms'; SELECT public.dispatch_work();",
  "SET statement_timeout='5s'; SELECT public.dispatch_work();",
])('rejects changed dispatcher safeguards: %s', changed => {
  expect(() => verifyCronCatalog(installed.map(job => job.jobname==='work-dispatcher' ? { ...job,command: changed } : job))).toThrow('Changed production command: work-dispatcher')
})

it('replay ticks execute both timeouts before dispatch', async () => {
  const statements: string[] = []
  const from = Date.parse('2026-10-28T00:00:00Z')
  await advanceCron({ from, to: from + 60000, move: async () => {}, invoke: async (statement: string) => { statements.push(statement) } })
  expect(statements).toHaveLength(2)
  expect(statements[0]).toContain('flush_league_inventory_hints')
  expect(statements[1]).toContain(command?.replace(/;$/, ''))
})
