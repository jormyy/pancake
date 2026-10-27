import assert from 'node:assert/strict'
import { sql, sqlJson } from './local-stack.mjs'
import { checkAllocation, checkChampion, checkDraftOrder, checkRealDraftBoard, rookieOrder } from './post-oracle.mjs'
import { playRookieTurns } from './rookie-turns.mjs'

const historicalResults = seasonId => sql(`SELECT md5(json_build_object('matchups',(SELECT json_agg(m ORDER BY id) FROM matchups m WHERE league_season_id='${seasonId}'),'standings',(SELECT json_agg(s ORDER BY id) FROM standings s WHERE league_season_id='${seasonId}'))::text)`)
const ownership = seasonId => sqlJson(`SELECT coalesce(json_agg(r ORDER BY member_id,player_id),'[]') FROM (SELECT member_id,player_id,is_on_ir,is_on_taxi FROM roster_players WHERE league_season_id='${seasonId}') r`, 'Official roster ownership')

export async function observeOfficialChampion(c, report, now) {
  if (report.champion) {
    assert.equal(await historicalResults(report.champion.seasonId), report.champion.history, 'Completed season results remain unchanged')
    return
  }
  const finals = await c.rest(c.users[0], `matchups?select=*&league_season_id=eq.${c.leagueSeasonId}&matchup_type=eq.playoff_final&is_finalized=eq.true`)
  if (!finals.length) return
  assert.equal(finals.length, 1)
  report.champion = { ...checkChampion(finals[0], finals[0]), seasonId: c.leagueSeasonId, finalizedAt: finals[0].finalized_at, observedAt: now, ownership: await ownership(c.leagueSeasonId), history: await historicalResults(c.leagueSeasonId) }
}

export async function verifyOfficialRollover(c, previous, report, now) {
  assert.ok(report.champion, 'Rollover requires the observed completed championship')
  const createdAt = await sql(`SELECT created_at FROM league_seasons WHERE id='${c.leagueSeasonId}'`)
  assert.ok(Date.parse(createdAt) >= Date.parse(report.champion.finalizedAt) + 48 * 3600000, 'Rollover preserves the full championship grace period')
  assert.equal(c.seasonYear, previous.seasonYear + 1)
  assert.deepEqual(await ownership(c.leagueSeasonId), report.champion.ownership, 'Rollover preserves every roster owner and destination')
  const picks = await c.rest(c.users[0], `draft_picks?select=*&league_id=eq.${c.leagueId}`)
  const allocation = [1, 2, 3].map(offset => checkAllocation(picks, c.users.map(user => user.memberId), c.seasonYear + offset))
  for (const user of c.users) {
    const [state] = await c.rpc(user, 'get_member_transaction_state', { p_member_id: user.memberId, p_league_id: c.leagueId })
    assert.equal(state.faab_balance, 100)
    assert.equal(state.weekly_add_count, 0)
  }
  report.rollover = { passed: true, previousSeason: previous.leagueSeasonId, nextSeason: c.leagueSeasonId, observedAt: now, allocation }
}

export async function runOfficialRookieDraft(c, input, report, move, now) {
  assert.ok(now >= Date.parse(input.draft.availableAt), 'Real draft board must already be available')
  report.realDraftBoard = checkRealDraftBoard(input.draft.rookies, await sqlJson('SELECT coalesce(json_agg(p),\'[]\') FROM players p WHERE nba_draft_number IS NOT NULL', 'Official rookie board'))
  const { draft } = await c.api(c.users[0], '/draft/start-rookie', { leagueId: c.leagueId, rounds: 3, timerSeconds: 60, timerExpiryBehavior: 'auto_pick' })
  const draftId = draft.id ?? draft.draft_id ?? draft.draftId
  assert.ok(draftId)
  const picks = await sqlJson(`SELECT json_agg(p ORDER BY overall_pick) FROM snake_draft_picks p WHERE draft_id='${draftId}'`, 'Official rookie picks')
  const assets = await c.rest(c.users[0], `draft_picks?select=*&league_id=eq.${c.leagueId}&season_year=eq.${c.seasonYear}`)
  const standings = await c.rest(c.users[0], `standings?select=*&league_season_id=eq.${report.champion.seasonId}`)
  const expectedOrder = rookieOrder(c.users.map(user => user.memberId), standings, draft.order_seed)
  checkDraftOrder({ picks, assets, expectedOrder, rounds: 3, orderType: draft.rookie_draft_order ?? 'linear' })
  const result = { draftId, picks: picks.length, expectedOrder }
  await playRookieTurns(c, draftId, move, result)
  const used = await c.rest(c.users[0], `draft_picks?select=*&league_id=eq.${c.leagueId}&season_year=eq.${c.seasonYear}&is_used=eq.true`)
  assert.equal(used.length, 30, 'All thirty rookie assets become used exactly once')
  result.passed = true
  report.rookieDraft = result
}
