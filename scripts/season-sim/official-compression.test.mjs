import test from 'node:test'
import assert from 'node:assert/strict'
import { compressionPolicy, materialLiveTicks } from './official-compression.mjs'
import { advanceCron } from './cron.mjs'

test('material coverage retains first live, each period, final, and unchanged-final retry', () => {
  const start = Date.UTC(2024, 9, 22, 23), end = start + 7200000
  const frames = [1000000, 2500000, 4000000, 5500000].map(offset => start + offset)
  const ticks = materialLiveTicks([{ start, end, frames }])
  for (const at of [start - 240000, start, start + 120000, ...frames, end, end + 120000, end + 1800000]) assert.ok(ticks.has(Math.ceil(at / 120000) * 120000))
  assert.throws(() => materialLiveTicks([{ start, end: start - 1, frames: [] }]))
})

test('coalescing fails closed for changed commands, pending work, and active workers', async () => {
  let state = { inventory: false }
  const receipt = {}, policy = compressionPolicy(new Set(), receipt, async () => state)
  const empty = { nextAt: null }, active = { nextAt: 60001 }
  const job = { jobname: 'league-inventory-hint-drain', command: 'SELECT private.flush_league_inventory_hints(1000)' }
  await policy.refresh(0, empty)
  assert.deepEqual(policy.select([job], 30000, empty), [])
  assert.equal(policy.select([{ ...job, command: `${job.command};SELECT 1` }], 30000, empty).length, 1)
  assert.equal(policy.select([job], 30000, active).length, 1)
  state = { inventory: true }
  await policy.refresh(30000, empty)
  assert.equal(policy.select([job], 60000, empty).length, 1)
  state = {}
  await policy.refresh(60000, empty)
  assert.equal(policy.select([job], 90000, empty).length, 1)
})

test('coalesced cron still wakes workers and preserves unknown scheduled jobs', async () => {
  const moved = [], invoked = [], receipt = {}
  const catalog = [
    { jobname: 'league-inventory-hint-drain', schedule: '30 seconds', command: 'SELECT private.flush_league_inventory_hints(1000)' },
    { jobname: 'unknown', schedule: '* * * * *', command: 'SELECT unknown()' },
  ]
  const policy = compressionPolicy(new Set(), receipt, async () => ({ inventory: false }))
  await advanceCron({ from: 0, to: 120000, catalog, compression: policy, move: async at => moved.push(at), invoke: async command => invoked.push(command), settle: async at => ({ nextAt: at === 60000 ? 80000 : null }) })
  assert.deepEqual(moved, [60000, 80000, 120000, 120000])
  assert.deepEqual(invoked, ['SELECT unknown()', 'SELECT unknown()'])
  assert.equal(receipt.coalesced['league-inventory-hint-drain:empty-source-queue'], 4)
})

test('notification and optimizer compression preserves time boundaries and queued obligations', async () => {
  const tip = 10800000
  let state = { tips: [new Date(tip).toISOString()], notifications: false, trades: false, drafts: false }
  const policy = compressionPolicy(new Set(), {}, async () => state)
  const workers = { nextAt: null }
  const notification = { jobname: 'notification-dispatch-minute', command: 'SELECT public.invoke_process_trades_if_due()' }
  const optimizer = { jobname: 'nba-lineup-optimizer', command: 'SELECT public.invoke_pre_tipoff_optimizer_if_due()' }
  await policy.refresh(0, workers)
  assert.equal(policy.select([notification], 60000, workers).length, 1)
  await policy.refresh(60000, workers)
  assert.equal(policy.select([notification, optimizer], 120000, workers).length, 0)
  assert.equal(policy.select([notification], tip - 7200000, workers).length, 1)
  assert.equal(policy.select([optimizer], tip - 120000, workers).length, 1)
  assert.equal(policy.select([notification], 900000, workers).length, 1)
  state = { ...state, notifications: true }
  await policy.refresh(900000, workers)
  assert.equal(policy.select([notification], 960000, workers).length, 1)
})

test('forecast compression never skips expiry or dirty input work', async () => {
  let state = { forecasts: false, forecastExpires: 180000 }
  const policy = compressionPolicy(new Set(), {}, async () => state)
  const workers = { nextAt: null }
  const job = { jobname: 'matchup-forecasts', command: 'SELECT public.invoke_matchup_forecasts_if_due()' }
  await policy.refresh(0, workers)
  assert.equal(policy.select([job], 60000, workers).length, 0)
  assert.equal(policy.select([job], 180000, workers).length, 1)
  state = { forecasts: true, forecastExpires: 999999 }
  await policy.refresh(0, workers)
  assert.equal(policy.select([job], 60000, workers).length, 1)
  state = {}
  await policy.refresh(0, workers)
  assert.equal(policy.select([job], 60000, workers).length, 1)
})
