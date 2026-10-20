import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { assertPendingWaivers, assertWaiverRollover, verifyWaivers } from './waiver-scenarios.mjs'
import { completeOffseasonTrade } from './trade-scenarios.mjs'
import { sql } from './local-stack.mjs'
import { assertClientScores } from './live-checks.mjs'
import { assertDomain } from './invariants.mjs'
import { checkChampion, checkAllocation, rookieOrder, checkDraftOrder } from './post-oracle.mjs'
import { maintenanceTick, rolloverDeadline, waitForRollover } from './maintenance.mjs'
import { expiryCronTick } from './cron.mjs'
import { checkSeasonHistory } from './history-oracle.mjs'

export async function finishSeason(c, move, report, checkpoint, { snapshot = async (..._args) => {}, stopAfterRollover = false } = {}) {
  const oldSeason = c.leagueSeasonId
  const began = Date.now()
  report.phaseTimings ??= []
  await checkpoint('automatic-champion')
  await move(Math.max(Date.parse('2026-04-13T14:00:00Z'), Number(await sql('SELECT extract(epoch FROM now())*1000'))))
  const history = await sql(`SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM player_game_stats s`)
  const historyQuery = `SELECT json_build_object('matchups',(SELECT json_agg(m ORDER BY m.id) FROM matchups m WHERE league_season_id='${oldSeason}'),'standings',(SELECT json_agg(s ORDER BY s.id) FROM standings s WHERE league_season_id='${oldSeason}'))`
  const resultsHistory = JSON.parse(await sql(historyQuery))
  const final = JSON.parse(await sql(`SELECT row_to_json(m) FROM matchups m WHERE league_season_id='${oldSeason}' AND matchup_type='playoff_final'`))
  assert.ok(final, 'The real season boundary must create the final')
  const championRead = await c.rest(c.users[0], `matchups?select=*&league_id=eq.${c.leagueId}&league_season_id=eq.${oldSeason}&matchup_type=eq.playoff_final`)
  await assertClientScores(c)
  report.champion = checkChampion(final, championRead[0])
  await snapshot('automatic-champion', '2026-04-12', 1)
  const pendingWaivers = c.waiverScenarios?.find(row => row.name === 'postseason-pending')
  if (pendingWaivers) {
    assert.ok(!pendingWaivers.checked, 'A genuine waiver batch remains pending when the final finalizes')
    report.pendingWaiversAtChampion = await assertPendingWaivers(c, pendingWaivers)
  }
  const pending = report.actions.tradeDeadline
  if (await sql(`SELECT status FROM trades WHERE id='${pending.pendingTrade}'`) === 'pending') await c.api(c.users[1], `/trades/${pending.pendingTrade}/accept`, { memberId: c.users[1].memberId })
  await move(Number(await sql('SELECT extract(epoch FROM now())*1000')) + 6 * 60000)
  assert.equal(await sql(`SELECT status FROM trades WHERE id='${pending.pendingTrade}'`), 'completed', 'Trading reopens after champion finalization')
  report.tradingReopened = { afterChampion: true, pendingTrade: pending.pendingTrade, passed: true }
  report.phaseTimings.push({ phase: 'season-end', seconds: (Date.now() - began) / 1000, businessAt: new Date(Number(await sql('SELECT extract(epoch FROM now())*1000'))).toISOString() })
  const start = Number(await sql('SELECT extract(epoch FROM now())*1000'))
  await snapshot('pre-rollover', '2026-04-12', 1)
  const latest = await sql(`SELECT max(finalized_at) FROM matchups WHERE league_season_id='${oldSeason}' AND matchup_type='playoff_final'`)
  const ready = Date.parse(latest) + 48 * 3600000
  assert.ok(Number.isFinite(ready), 'The final must be finalized before waiting for rollover')
  const deadline = rolloverDeadline(start, ready, c.waiverScenarios)
  const rolloverBegan = Date.now()
  report.rolloverRecovery = await waitForRollover({ start, deadline, oldSeason,
    move: async at => { await checkpoint(`${at}:playoff-grace`); await move(at); await verifyWaivers(c, report) },
    tick: () => maintenanceTick(),
    current: async () => {
      const current = await sql(`SELECT id FROM league_seasons WHERE league_id='${c.leagueId}' AND is_current`)
      const now = Number(await sql('SELECT extract(epoch FROM now())*1000'))
      if (now < ready) assert.equal(current, oldSeason, 'Rollover must wait the full 48-hour grace')
      return current
    },
  })
  c.leagueSeasonId = report.rolloverRecovery.season
  assert.notEqual(c.leagueSeasonId, oldSeason, 'Real season-boundary must roll over the league')
  assert.equal(await sql(`SELECT season_year FROM league_seasons WHERE id='${c.leagueSeasonId}'`), '2027')
  assert.equal(await sql(`SELECT status FROM leagues WHERE id='${c.leagueId}'`), 'offseason')
  const decided = JSON.parse(await sql(`SELECT json_agg(m ORDER BY playoff_round) FROM matchups m WHERE league_season_id='${oldSeason}' AND matchup_type<>'regular_season'`))
  for (const matchup of decided) {
    assert.ok(matchup.is_finalized && matchup.winner_member_id, 'Every playoff result must be decided')
    if (matchup.home_points !== matchup.away_points) assert.equal(matchup.winner_member_id, matchup.home_points > matchup.away_points ? matchup.home_member_id : matchup.away_member_id)
  }
  const regular = JSON.parse(await sql(`SELECT json_agg(m) FROM matchups m WHERE league_season_id='${oldSeason}' AND matchup_type='regular_season' AND NOT is_voided`))
  const ranked = c.users.map(user => {
    const results = regular.filter(row => [row.home_member_id, row.away_member_id].includes(user.memberId))
    return { memberId: user.memberId, wins: results.filter(row => row.winner_member_id === user.memberId).length, points: results.reduce((sum, row) => sum + (row.home_member_id === user.memberId ? row.home_points : row.away_points), 0), maximum: results.reduce((sum, row) => sum + (row.home_member_id === user.memberId ? row.home_max_possible_points : row.away_max_possible_points), 0), against: results.reduce((sum, row) => sum + (row.home_member_id === user.memberId ? row.away_points : row.home_points), 0), token: createHash('sha256').update(`${oldSeason}:${user.memberId}`).digest('hex') }
  }).sort((a, b) => b.wins - a.wins || b.points - a.points || b.maximum - a.maximum || a.against - b.against || a.token.localeCompare(b.token) || a.memberId.localeCompare(b.memberId))
  const seeds = JSON.parse(await sql(`SELECT to_json(playoff_bracket_seed_ids) FROM league_seasons WHERE id='${oldSeason}'`))
  assert.deepEqual(seeds, ranked.map(row => row.memberId), 'Playoff seeds agree with independently ranked regular results')
  const settings = JSON.parse(await sql(`SELECT json_build_object('entrants',playoff_entrants,'start',playoff_start_week,'lengths',playoff_round_lengths) FROM leagues WHERE id='${c.leagueId}'`))
  let roundStart = settings.start
  for (const [index, length] of settings.lengths.entries()) {
    const rows = decided.filter(row => row.playoff_round === index + 1)
    assert.equal(rows.length, settings.entrants / 2 ** (index + 1), 'Bracket size follows league settings')
    for (const row of rows) {
      assert.equal(row.week_number, roundStart, 'Playoff round starts in the configured week')
      assert.equal(row.end_week_number, roundStart + length - 1, 'Playoff span follows configured round length')
    }
    roundStart += length
  }
  const rounds = [...new Set(decided.map(row => row.playoff_round))].sort((a, b) => a - b)
  for (const matchup of decided) {
    const prerequisites = matchup.playoff_round === rounds[0] ? regular : decided.filter(row => row.playoff_round === matchup.playoff_round - 1)
    const ready = Math.max(...prerequisites.map(row => Date.parse(row.finalized_at))) + 48 * 3600000
    assert.ok(Date.parse(matchup.created_at) >= ready, 'Bracket creation and advancement must wait 48 hours')
  }
  for (const round of rounds.slice(1)) {
    const previous = decided.filter(row => row.playoff_round === round - 1).map(row => row.winner_member_id)
    for (const matchup of decided.filter(row => row.playoff_round === round)) for (const member of [matchup.home_member_id, matchup.away_member_id]) assert.ok(previous.includes(member), 'Only preceding round winners advance')
  }
  assert.equal(await sql(`SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM player_game_stats s`), history, 'Automatic rollover preserves all stored game stats')
  report.rolloverHistory = checkSeasonHistory(resultsHistory, JSON.parse(await sql(historyQuery)), c.expectedWaiverPriorities)
  await assertWaiverRollover(c, oldSeason, report)
  report.phaseTimings.push({ phase: 'rollover', seconds: (Date.now() - rolloverBegan) / 1000, businessAt: report.rolloverRecovery.at })
  c.previousSeasonId = oldSeason
  c.previousChampionId = final.id
  await snapshot('post-rollover', '2026-04-12', 1)
  if (stopAfterRollover) return { passed: true, oldSeason, newSeason: c.leagueSeasonId, playoffGames: decided.length }
  return finishRookieDraft(c, move, report, checkpoint, { snapshot })
}

export async function finishRookieDraft(c, move, report, checkpoint, { snapshot = async (..._args) => {} } = {}) {
  const oldSeason = c.previousSeasonId
  const history = await sql(`SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM player_game_stats s`)
  const final = JSON.parse(await sql(`SELECT row_to_json(m) FROM matchups m WHERE id='${c.previousChampionId}'`))
  const decided = JSON.parse(await sql(`SELECT json_agg(m) FROM matchups m WHERE league_season_id='${oldSeason}' AND matchup_type<>'regular_season'`))
  report.phaseTimings ??= []
  const offseasonBegan = Date.now()
  await checkpoint('offseason-to-rookie-draft')
  await move(Math.max(Date.parse('2026-06-26T14:00:00Z'), Number(await sql('SELECT extract(epoch FROM now())*1000'))))
  await snapshot('pre-draft', '2026-04-12', 1)
  report.phaseTimings.push({ phase: 'offseason-to-rookie-draft', seconds: (Date.now() - offseasonBegan) / 1000, businessAt: new Date(Number(await sql('SELECT extract(epoch FROM now())*1000'))).toISOString() })
  const draftBegan = Date.now()
  await checkpoint('rookie-draft')
  const commissioner = c.users[0]
  await c.rpc(commissioner, 'update_league_settings_atomic', { p_league_id: c.leagueId, p_settings: { waiver_mode: 'rolling' } })
  report.waiverModeChange = { route: '/rest/v1/rpc/update_league_settings_atomic', from: 'faab', to: 'rolling', reason: 'One retained league covers both waiver modes and the same cross-season assets.' }
  const { draft } = await c.api(commissioner, '/draft/start-rookie', { leagueId: c.leagueId, rounds: 2, timerSeconds: 5, timerExpiryBehavior: 'auto_pick' })
  const draftId = draft.id ?? draft.draft_id ?? draft.draftId
  assert.ok(draftId, JSON.stringify(draft))
  const picks = JSON.parse(await sql(`SELECT json_agg(p ORDER BY overall_pick) FROM snake_draft_picks p WHERE draft_id='${draftId}'`))
  assert.equal(picks.length, c.users.length * 2)
  const assets = JSON.parse(await sql(`SELECT json_agg(p) FROM draft_picks p WHERE league_id='${c.leagueId}' AND season_year=2027`))
  for (const pick of picks) assert.equal(pick.member_id, assets.find(asset => asset.id === pick.draft_pick_id)?.current_owner_id, 'Traded pick ownership controls the draft slot')
  assert.ok(assets.some(asset => asset.current_owner_id !== asset.original_owner_id), 'The rookie draft must include a previously traded pick')
  const standings = await c.rest(c.users[0], `standings?select=*&league_season_id=eq.${oldSeason}`)
  const expectedOrder = rookieOrder(c.users.map(user => user.memberId), standings)
  checkDraftOrder({ picks, assets, expectedOrder, rounds: 2 })
  const order = JSON.parse(await sql(`SELECT json_agg(member_id ORDER BY position) FROM draft_orders WHERE draft_id='${draftId}'`))
  assert.deepEqual(order, expectedOrder, 'Draft order agrees with independently sorted prior standings')
  await move(expiryCronTick(picks[0].timer_expires_at))
  const expired = JSON.parse(await sql(`SELECT row_to_json(p) FROM snake_draft_picks p WHERE draft_id='${draftId}' AND overall_pick=1`))
  assert.ok(expired.player_id && expired.picked_at, 'Production expiry gate must make the timed-out rookie pick')
  report.rookieAutoPick = { draftId, pick: expired, passed: true }
  for (const pick of picks.slice(1)) {
    const already = await sql(`SELECT player_id FROM snake_draft_picks WHERE id='${pick.id}'`)
    if (already) continue
    const user = c.users.find(user => user.memberId === pick.member_id)
    const playerId = await sql(`SELECT id FROM players WHERE display_name LIKE 'Synthetic Prospect 2026 %' AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id='${c.leagueId}' AND r.player_id=players.id) ORDER BY nba_draft_number,id LIMIT 1`)
    assert.ok(playerId)
    await c.api(user, `/draft/${draftId}/snake-pick`, { memberId: user.memberId, playerId, toTaxi: true })
  }
  assert.equal(await sql(`SELECT status FROM drafts WHERE id='${draftId}'`), 'completed')
  const after = await sql(`SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM player_game_stats s`)
  assert.equal(after, history, 'Rollover and rookie draft must preserve all game stat rows exactly')
  assert.equal(await sql(`SELECT is_current FROM league_seasons WHERE id='${oldSeason}'`), 'f')
  const currentPicks = JSON.parse(await sql(`SELECT json_agg(p) FROM draft_picks p WHERE league_id='${c.leagueId}'`))
  report.pickAllocation = checkAllocation(currentPicks, c.users.map(user => user.memberId), 2032)
  const unused = currentPicks.filter(pick => pick.season_year === 2027 && pick.round === 3)
  assert.equal(unused.length, c.users.length)
  assert.ok(unused.every(pick => !pick.is_used), 'Unselected third-round picks remain unused after a two-round draft')
  for (const pick of report.actions.tradeDeadline.transferredPicks) assert.equal(currentPicks.find(row => row.id === pick.id)?.current_owner_id, pick.owner, 'Future traded picks retain ownership across rollover and draft')
  report.offseasonTrade = await completeOffseasonTrade(c, move)
  const oldChampion = await c.rest(c.users[0], `matchups?select=*&id=eq.${final.id}`)
  const currentBracket = await c.rest(c.users[0], `matchups?select=*&league_season_id=eq.${c.leagueSeasonId}&matchup_type=in.(playoff_quarterfinal,playoff_semifinal,playoff_final)`)
  report.previousChampion = { authenticatedHistoricalRowReadable: oldChampion[0]?.winner_member_id === final.winner_member_id, currentSeasonBracketShowsPreviousChampion: currentBracket.some(row => row.id === final.id), currentSeasonBracketRule: 'lib/bracket.ts getPlayoffBracket filters the current league season' }
  const domain = await assertDomain(c)
  report.phaseTimings.push({ phase: 'rookie-draft-and-offseason-trade', seconds: (Date.now() - draftBegan) / 1000, businessAt: new Date(Number(await sql('SELECT extract(epoch FROM now())*1000'))).toISOString() })
  report.actions.completed.push('Automatic champion, playoff grace, rollover, independent rookie order, timed auto-pick, far-year picks, retained history')
  return { passed: true, oldSeason, newSeason: c.leagueSeasonId, playoffGames: decided.length, rookiePicks: picks.length, historyPreserved: true, domain, rookieProvenance: 'SYNTHETIC prospects through production annual draft-board ingestion' }
}
