import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { setupMultiTeamTradeGameplayFixture } from './trade-fixture.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { env, faabRoutes, propose, setBalances, setLeagueRules } from './multi-team-trade-db-support.mjs'

await runWithScenarioResourceOwner('trade rule transport', async () => {
  const fixture = await setupMultiTeamTradeGameplayFixture(env, 0, { isolatedPlayers: true })
  await setLeagueRules(fixture, { waiver_mode: 'faab', trade_veto_mode: 'commissioner', trade_veto_window_hours: 1 })
  await setBalances(fixture, [[fixture.proposer.id, 100], [fixture.recipient.id, 0], [fixture.observer.id, 0]])
  const tradeId = await propose(fixture, faabRoutes(fixture), 'Trade rule transport regression')
  await setBalances(fixture, [[fixture.proposer.id, 60]])
  const bounded = createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false },
    global: { fetch: (input, options) => fetch(input, { ...options, signal: AbortSignal.timeout(3000) }) },
  })
  const { error, status } = await bounded.rpc('accept_trade_atomic', {
    p_trade_id: tradeId,
    p_accepting_member_id: fixture.recipient.id,
  })
  assert.equal(status, 400, 'A rejected trade returns a valid HTTP response')
  assert.equal(error?.code, 'PA010')
  assert.match(error.message, /enough FAAB/)
  const participant = await fixture.admin.from('trade_participants').select('accepted_at')
    .eq('trade_id', tradeId).eq('member_id', fixture.recipient.id).single()
  assert.equal(participant.error, null)
  assert.equal(participant.data.accepted_at, null)
  console.log('PASS rejected FAAB acceptance responds promptly and leaves the participant unchanged')
})
