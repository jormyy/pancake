import assert from 'node:assert/strict'
import process from 'node:process'
import { test, vi } from 'vitest'
import { setupTradeGameplayFixture } from './trade-fixture.mjs'
import { setupFuturePickChain } from './soak-support.mjs'
import { verifyLeagueState } from './browser-league-lifecycle.mjs'
import { runInvariants } from './soak-realtime-invariants.mjs'
import { assertLeagueLifecycleScenario } from './soak-trade-lifecycle.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  writeFile: vi.fn(async () => {}),
}))

test.skipIf(process.env.PANCAKE_PICK_WINDOW_DB_TESTS !== '1')('pick fixtures use three future draft classes', async () => {
  const supabaseUrl = process.env.E2E_SUPABASE_URL
  const serviceRoleKey = process.env.E2E_PANCAKE_SUPABASE_SECRET_KEY
  const anonKey = process.env.E2E_SUPABASE_PUBLISHABLE_KEY
  assert.ok(supabaseUrl && serviceRoleKey && anonKey, 'Local database API credentials are required')
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(supabaseUrl).hostname), 'Use an isolated local API')
  const env = { supabaseUrl, serviceRoleKey, anonKey }

  await runWithScenarioResourceOwner('pick window fixtures', async (resourceOwner) => {
    const fixture = await setupTradeGameplayFixture(env, 0, { isolatedPlayers: true })
    assert.equal(fixture.targetFuturePickYear, fixture.currentSeason.season_year + 3)
    assert.ok(fixture.proposerFuturePick && fixture.recipientFuturePick)
    assert.equal(fixture.proposerFuturePick.seasonYear, fixture.targetFuturePickYear)
    assert.equal(fixture.recipientFuturePick.seasonYear, fixture.targetFuturePickYear)
    console.log('PASS: trade fixtures use the third future draft')

    const state = await verifyLeagueState({
      admin: fixture.admin,
      leagueId: fixture.league.id,
      commissionerUserId: fixture.users[0].id,
      managerUserId: fixture.users[1].id,
      inviteCode: fixture.league.invite_code,
    })
    assert.deepEqual(state.failures, [])
    assert.equal(state.pickCount, 18)
    console.log('PASS: browser league checks expect three future drafts')

    const chainFixture = await setupTradeGameplayFixture(env, 1, { memberCount: 4, includeFuturePicks: false, isolatedPlayers: true })
    const invariants = await runInvariants(chainFixture.admin, chainFixture.league.id)
    assert.deepEqual(invariants.filter(failure => failure.startsWith('D.SEA.6:')), [])
    const lifecycle = await assertLeagueLifecycleScenario({
      supabase: chainFixture.admin,
      env,
      state: { users: chainFixture.users, password: chainFixture.password, runId: chainFixture.runId },
      season: 0,
      resourceOwner,
    })
    assert.deepEqual(lifecycle.failures, [])
    assert.equal(lifecycle.artifact.pickWindow.maxPickYear, chainFixture.currentSeason.season_year + 3)
    console.log('PASS: soak lifecycle and rollover checks use three future drafts')

    const { error } = await chainFixture.admin.from('draft_picks').insert({
      league_id: chainFixture.league.id,
      season_year: chainFixture.currentSeason.season_year + 5,
      round: 1,
      original_owner_id: chainFixture.proposer.id,
      current_owner_id: chainFixture.proposer.id,
    })
    assert.equal(error, null)
    const chain = await setupFuturePickChain(chainFixture.admin, chainFixture.league.id)
    assert.equal(chain.targetYear, chainFixture.currentSeason.season_year + 3)
    const { data: pick, error: readError } = await chainFixture.admin.from('draft_picks')
      .select('current_owner_id').eq('id', chain.targetPickId).single()
    assert.equal(readError, null)
    assert.ok(pick)
    assert.equal(pick.current_owner_id, chain.finalOwnerId)
    assert.equal(chain.tradeIds.length, 3)
    console.log('PASS: soak pick chains ignore retained distant drafts')
  })
}, 60_000)
