import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'vitest'
import * as runner from '../../scripts/ios-sim/run.mjs'

const folder = 'scripts/ios-sim/scenarios'

test('scenario names have one source across all supplied files', async () => {
  const names = new Map<string, string>()
  for (const file of await readdir(folder)) {
    if (!file.endsWith('.json')) continue
    for (const scenario of JSON.parse(await readFile(path.join(folder, file), 'utf8'))) {
      assert.ok(!names.has(scenario.name), `${scenario.name} occurs in both ${names.get(scenario.name)} and ${file}`)
      names.set(scenario.name, file)
    }
  }
})

test('draft room captures use isolated fixtures instead of stack-specific IDs', async () => {
  for (const file of ['league-cached-bid.json', 'league-clock.json']) {
    const scenarios = JSON.parse(await readFile(path.join(folder, file), 'utf8'))
    for (const scenario of scenarios) {
      const source = JSON.stringify(scenario)
      assert.doesNotMatch(source, /draftId=[a-f0-9-]{36}/)
      if (!source.includes('draftId={{draftId}}')) continue
      assert.equal(scenario.setup.draftId, '{{draftId}}')
      assert.equal(scenario.setup.draftRoom, source.includes('/rookie-draft-room') ? 'snake' : 'auction')
      if (scenario.setup.draftRoom === 'auction') assert.equal(scenario.setup.auctionNomination, true)
    }
  }
})

test('repeat expands independent scenarios with unique report IDs', () => {
  const template = { name: 'room', from: '/profile', repeat: 3, prepare: [{ tap: 'Light' }], steps: [{ action: { open: '/draft' } }] }
  const original = JSON.stringify(template)
  const scenarios = runner.expandScenarios([template, { name: 'single', steps: [] }])
  assert.deepEqual(scenarios.map((scenario: any) => scenario.name), ['room-repeat-1', 'room-repeat-2', 'room-repeat-3', 'single'])
  assert.ok(scenarios.slice(0, 3).every((scenario: any) => scenario.from === '/profile' && scenario.prepare[0].tap === 'Light' && scenario.steps.length === 1))
  assert.equal(JSON.stringify(template), original)
  for (const repeat of [0, -1, 1.5, '2']) assert.throws(() => runner.expandScenarios([{ ...template, repeat }]), /repeat/)
  assert.throws(() => runner.expandScenarios([template, template]), /Duplicate scenario/)
  assert.throws(() => runner.expandScenarios([template, { name: 'room-repeat-1' }]), /Duplicate scenario/)
})

test('recapture entry files retain their surfaces', async () => {
  for (const file of ['shell.json', 'home.json', 'roster.json', 'players.json', 'player-controls.json', 'trades.json', 'trade-review.json', 'league.json', 'league-member.json']) {
    const scenarios = JSON.parse(await readFile(path.join(folder, file), 'utf8'))
    assert.ok(scenarios.length, `${file} needs scenarios`)
  }
  const home = JSON.parse(await readFile(path.join(folder, 'home.json'), 'utf8'))
  for (const theme of ['light', 'dark']) assert.ok(home.some((scenario: any) => scenario.name === `home-${theme}-manual-entry`))
})
