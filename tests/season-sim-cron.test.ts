import { expect, it } from 'vitest'
import { advanceCron, productionJobs, verifyCronCatalog } from '../scripts/season-sim/cron.mjs'

const dispatcher = productionJobs.find(job => job.jobname === 'work-dispatcher')

it('accepts the dispatcher command the migrations install', () => {
  expect(dispatcher?.command).toMatch(/statement_timeout/)
  expect(dispatcher?.command).toMatch(/lock_timeout/)
  expect(verifyCronCatalog(productionJobs)).toBe(true)
})

it.each([
  "SELECT public.dispatch_work()",
  "SET statement_timeout='50s'; SET lock_timeout='250ms'; SELECT public.dispatch_work();",
  "SET statement_timeout='5s'; SELECT public.dispatch_work();",
  "SET statement_timeout='5s'; SET lock_timeout='250ms'; SELECT public.dispatch_work();",
])('rejects changed dispatcher safeguards: %s', changed => {
  expect(() => verifyCronCatalog(productionJobs.map(job => job.jobname === 'work-dispatcher' ? { ...job, command: changed } : job))).toThrow('Changed production command: work-dispatcher')
})

it('replay ticks execute the installed dispatcher command with both timeouts', async () => {
  const statements: string[] = []
  const from = Date.parse('2026-10-28T00:00:00Z')
  await advanceCron({ from, to: from + 60000, move: async () => {}, invoke: async (statement: string) => { statements.push(statement) } })
  expect(statements).toHaveLength(1)
  expect(statements[0]).toContain(dispatcher?.command.replace(/;$/, ''))
})
