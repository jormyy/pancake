import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceCron, cronCommands, cronMatches, expiryCronTick, productionJobs, verifyCronCatalog, mergeCronCatalog } from './cron.mjs'

test('rookie expiry waits for its production minute without expiring the following pick', () => {
  const start = Date.parse('2026-06-26T14:00:11Z')
  const firstExpiry = new Date(start + 5000).toISOString()
  const tick = expiryCronTick(firstExpiry)
  assert.equal(tick, Date.parse('2026-06-26T14:01:00Z'))
  const nextExpiry = tick + 5000
  assert.ok(tick < nextExpiry)
  assert.ok(start + 60000 >= nextExpiry, 'The old fixed wait leaves the next pick expired')
  assert.equal(expiryCronTick('2026-06-26T14:01:00Z'), Date.parse('2026-06-26T14:02:00Z'))
  assert.throws(() => expiryCronTick(null), /real pick expiry/)
})

test('production gates and annual UTC draft window match the migration catalog', () => {
  assert.ok(verifyCronCatalog(productionJobs))
  assert.throws(() => verifyCronCatalog(productionJobs.map(job => job.jobname === 'work-dispatcher' ? { ...job, schedule: '*/2 * * * *' } : job)), /cadence/)
  assert.ok(cronMatches('0 13 20-30 6 *', '2026-06-26T13:00:00Z'))
  assert.ok(!cronMatches('0 13 20-30 6 *', '2026-06-19T13:00:00Z'))
  assert.ok(cronCommands('2026-04-13T00:02:00Z').some(job => job.jobname === 'work-dispatcher'))
  assert.ok(!productionJobs.some(job => /invoke_edge_function\('sync-(stats|scores)'/.test(job.command)))
})
test('clock jumps preserve every minute gate and half-minute hint drain', async () => {
  const moves = [], samples = [], statements = []
  const from = Date.parse('2026-04-12T23:59:30Z')
  const counts = await advanceCron({ from, to: from + 6 * 60000,
    move: async at => { moves.push(at) }, invoke: async statement => { statements.push(statement) }, sample: async at => { samples.push(at) },
  })
  assert.deepEqual(samples, Array.from({ length: 12 }, (_, index) => from + (index + 1) * 30_000))
  assert.equal(counts['work-dispatcher'], 6)
  assert.equal(counts['io-hint-drain'], 12)
  assert.equal(counts['season-boundary'], undefined)
  assert.equal(counts['notification-dispatch-minute'], undefined)
  assert.equal(counts['nba-process-trades'], undefined)
  assert.equal(statements.length, 12)
  assert.equal(moves.at(-1), from + 6 * 60000)
  await assert.rejects(advanceCron({ from: 1, to: 0, move: async () => {}, invoke: async () => {} }), /backwards/)
})

test('discrete cron preserves minute gates while waking internal ticks between them', async () => {
  const from = Date.parse('2026-04-12T23:59:00Z'), to = from + 180000
  const counts = {}, moves = [], wakes = [from + 80000, from + 90000, from + 100000]
  await advanceCron({ from, to, counts,
    move: async at => { moves.push(at) }, invoke: async () => {},
    settle: async at => ({ nextAt: wakes.find(wake => wake > at) ?? null }),
  })
  assert.equal(counts['work-dispatcher'], 3)
  assert.equal(counts['nba-close-expired-nominations'], undefined)
  assert.ok(wakes.every(wake => moves.includes(wake)))
  assert.equal(moves.at(-1), to)
  await assert.rejects(advanceCron({ from, to, move: async () => {}, invoke: async () => {}, settle: async () => ({ nextAt: from }) }), /timer must settle/)
})

test('reusing a stack preserves its captured cron catalog and detects changed migration jobs', () => {
  assert.deepEqual(mergeCronCatalog([], productionJobs), [...productionJobs].sort((a, b) => a.jobname.localeCompare(b.jobname)))
  assert.throws(() => mergeCronCatalog([]), /Missing production cron/)
  assert.throws(() => mergeCronCatalog([{ ...productionJobs.find(row=>row.jobname==='work-dispatcher'), schedule: '*/2 * * * *' }], productionJobs), /Changed production cadence/)
})

test('cadence profiles retain minute gates and coalesce matching half-minute worker wakes', async () => {
  const from = Date.parse('2026-03-23T12:59:00Z'), rows = []
  await advanceCron({ from, to: from + 120000, move: async () => {}, invoke: async () => {},
    settle: async at => ({ nextAt: at < from + 90000 ? from + 90000 : null }),
    profile: row => { rows.push(row) },
  })
  assert.equal(rows.filter(row => row.minute).length, 2)
  assert.deepEqual(rows.filter(row => !row.minute).map(row => row.at), [from + 30_000, from + 90_000])
  assert.ok(rows.every(row => row.wallSeconds >= 0))
})

test('the replay runs only the production work dispatcher',()=>{
  assert.ok(!productionJobs.some(row=>['refresh-player-search-caches','nba-process-trades'].includes(row.jobname)))
  assert.ok(cronCommands(Date.parse('2024-10-22T12:45:00Z')).some(row=>row.jobname==='work-dispatcher'))
})

test('the replay uses the real per-minute work dispatcher',()=>{
  assert.ok(cronCommands(Date.parse('2025-06-28T13:02:00Z')).some(row=>row.jobname==='work-dispatcher'&&row.command.includes('dispatch_work')))
})
test('an installed catalog controls dispatch without importing legacy jobs', async () => {
  const catalog = [{ jobname: 'candidate-job', schedule: '*/2 * * * *', command: 'SELECT candidate_job()' }]
  const from = Date.parse('2025-01-01T00:00:00Z'), statements = []
  assert.deepEqual(cronCommands(from + 120000, catalog), catalog)
  assert.deepEqual(cronCommands(from + 60000, catalog), [])
  const counts = await advanceCron({ from, to: from + 240000, catalog, move: async () => {}, invoke: async statement => statements.push(statement) })
  assert.deepEqual(counts, { 'candidate-job': 2 })
  assert.equal(statements.filter(statement => statement.includes('candidate_job')).length, 2)
  assert.ok(statements.every(statement => !statement.includes('nba-live-poll')))
})

test('installed subminute jobs run between minute jobs and worker wakes', async () => {
  const catalog = [{ jobname: 'drain', schedule: '30 seconds', command: 'SELECT drain()' }, { jobname: 'minute', schedule: '* * * * *', command: 'SELECT tick()' }]
  const from = Date.parse('2025-01-01T00:00:00Z')
  for (const settle of [null, async () => ({ nextAt: null })]) {
    const counts = await advanceCron({ from, to: from + 120000, catalog, settle, move: async () => {}, invoke: async () => {} })
    assert.deepEqual(counts, { drain: 4, minute: 2 })
  }
  assert.throws(() => cronMatches('0 seconds', from), /Unsupported cron interval/)
})
