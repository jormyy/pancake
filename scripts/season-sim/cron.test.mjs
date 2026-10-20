import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceCron, cronCommands, cronMatches, productionJobs, verifyCronCatalog } from './cron.mjs'

test('production gates and annual UTC draft window match the migration catalog', () => {
  assert.ok(verifyCronCatalog(productionJobs))
  assert.throws(() => verifyCronCatalog(productionJobs.map(job => job.jobname === 'nba-live-poll' ? { ...job, schedule: '* * * * *' } : job)), /cadence/)
  assert.ok(cronMatches('0 13 20-30 6 *', '2026-06-26T13:00:00Z'))
  assert.ok(!cronMatches('0 13 20-30 6 *', '2026-06-19T13:00:00Z'))
  assert.ok(cronCommands('2026-04-13T00:02:00Z').some(job => job.jobname === 'nba-live-poll'))
  assert.ok(!productionJobs.some(job => /invoke_edge_function\('sync-(stats|scores)'/.test(job.command)))
})
test('clock jumps execute every intervening minute with no missing gate ticks', async () => {
  const moves = [], samples = [], statements = []
  const from = Date.parse('2026-04-12T23:59:30Z')
  const counts = await advanceCron({ from, to: from + 6 * 60000,
    move: async at => { moves.push(at) }, invoke: async statement => { statements.push(statement) }, sample: async at => { samples.push(at) },
  })
  assert.equal(samples.length, 6)
  assert.equal(counts['nba-live-poll'], 3)
  assert.equal(counts['season-boundary'], 1)
  assert.equal(counts['nba-process-trades'], 2)
  assert.equal(statements.length, 6)
  assert.equal(moves.at(-1), from + 6 * 60000)
  await assert.rejects(advanceCron({ from: 1, to: 0, move: async () => {}, invoke: async () => {} }), /backwards/)
})
