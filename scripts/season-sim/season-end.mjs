import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { dispatch } from './dispatch.mjs'
import { sql } from './local-stack.mjs'
import { assertDomain } from './invariants.mjs'
import { maintenanceTick, waitForRollover } from './maintenance.mjs'

export async function finishSeason(c, move, report, checkpoint, { continuation = false } = {}) {
  const oldSeason = c.leagueSeasonId
  if (!continuation) {
    await checkpoint('full-final-delivery-rerun')
    const duplicateBefore = await sql(`SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM player_game_stats s`)
    for (const date of report.dates) await dispatch(`SELECT public.invoke_edge_function('sync-stats','{"date":"${date}"}')`)
    assert.equal(await sql(`SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM player_game_stats s`), duplicateBefore, 'Repeating every date must not change stored player stat rows')
    report.events.finalDateReruns = report.dates.length
  } else assert.equal(report.events.finalDateReruns, report.dates.length, 'Continuation requires the completed idempotent final rerun')
  const history = await sql(`SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM player_game_stats s`)
  const final = JSON.parse(await sql(`SELECT row_to_json(m) FROM matchups m WHERE league_season_id='${oldSeason}' AND matchup_type='playoff_final'`))
  assert.ok(final, 'The real season boundary must create the final')
  const start = Number(await sql('SELECT extract(epoch FROM now())*1000'))
  await dispatch(`SELECT public.invoke_edge_function('sync-scores','{"date":"${new Date(start).toISOString()}"}')`)
  const latest = await sql(`SELECT max(finalized_at) FROM matchups WHERE league_season_id='${oldSeason}' AND matchup_type='playoff_final'`)
  const ready = Date.parse(latest) + 48 * 3600000
  assert.ok(Number.isFinite(ready), 'The final must be finalized before waiting for rollover')
  const deadline = continuation ? start + 30 * 60000 : Math.max(start, ready) + 26 * 3600000
  report.rolloverRecovery = await waitForRollover({ start, deadline, oldSeason,
    move: async at => { await checkpoint(`${at}:playoff-grace`); await move(at) },
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
  const rounds = [...new Set(decided.map(row => row.playoff_round))].sort((a, b) => a - b)
  for (const matchup of decided) {
    const prerequisites = matchup.playoff_round === rounds[0] ? regular : decided.filter(row => row.playoff_round === matchup.playoff_round - 1)
    const ready = Math.max(...prerequisites.map(row => Date.parse(row.finalized_at))) + 48 * 3600000
    assert.ok(Date.parse(matchup.created_at) >= ready, 'Bracket creation and advancement must wait 48 hours')
  }
  assert.ok(regular.some(row => row.home_points === 0 && row.away_points === 0 && row.winner_member_id == null), 'The empty-lineup week must create a real tied result')
  assert.ok(report.days.some(day => day.lineups.postLockRejections > 0))
  assert.equal(report.events.outOfOrder, 1)
  assert.equal(report.events.overlap, 1)
  assert.equal(report.days.flatMap(day => day.postponements).filter(item => item.observed.status === 'Final').length, 4)
  assert.ok(report.actions.irReturns?.length, 'A real injury recovery must exercise the IR return restriction')
  for (const round of rounds.slice(1)) {
    const previous = decided.filter(row => row.playoff_round === round - 1).map(row => row.winner_member_id)
    for (const matchup of decided.filter(row => row.playoff_round === round)) for (const member of [matchup.home_member_id, matchup.away_member_id]) assert.ok(previous.includes(member), 'Only preceding round winners advance')
  }
  await checkpoint('rookie-draft')
  await move('2026-06-26T14:00:00Z')
  await dispatch(`SELECT public.invoke_edge_function('sync-draft-order','{"seasonYear":2026}')`)
  const commissioner = c.users[0]
  const { draft } = await c.api(commissioner, '/draft/start-rookie', { leagueId: c.leagueId, rounds: 2, timerSeconds: 120 })
  const draftId = draft.id ?? draft.draft_id ?? draft.draftId
  assert.ok(draftId, JSON.stringify(draft))
  const picks = JSON.parse(await sql(`SELECT json_agg(p ORDER BY overall_pick) FROM snake_draft_picks p WHERE draft_id='${draftId}'`))
  assert.equal(picks.length, 8)
  const assets = JSON.parse(await sql(`SELECT json_agg(p) FROM draft_picks p WHERE league_id='${c.leagueId}' AND season_year=2027`))
  for (const pick of picks) assert.equal(pick.member_id, assets.find(asset => asset.id === pick.draft_pick_id)?.current_owner_id, 'Traded pick ownership controls the draft slot')
  assert.ok(assets.some(asset => asset.current_owner_id !== asset.original_owner_id), 'The rookie draft must include a previously traded pick')
  const order = JSON.parse(await sql(`SELECT json_agg(member_id ORDER BY position) FROM draft_orders WHERE draft_id='${draftId}'`))
  for (const pick of picks) {
    const expectedOriginal = order[(pick.round % 2 === 1 ? pick.pick_in_round - 1 : 4 - pick.pick_in_round)]
    if (expectedOriginal) assert.equal(assets.find(asset => asset.id === pick.draft_pick_id).original_owner_id, expectedOriginal, 'Snake reverses the original pick order')
    const user = c.users.find(user => user.memberId === pick.member_id)
    const playerId = await sql(`SELECT id FROM players WHERE display_name='Synthetic Prospect 2026 ${pick.overall_pick}'`)
    assert.ok(playerId)
    await c.api(user, `/draft/${draftId}/snake-pick`, { memberId: user.memberId, playerId, toTaxi: true })
  }
  assert.equal(await sql(`SELECT status FROM drafts WHERE id='${draftId}'`), 'completed')
  const after = await sql(`SELECT md5(string_agg(row_to_json(s)::text,'' ORDER BY s.id)) FROM player_game_stats s`)
  assert.equal(after, history, 'Rollover and rookie draft must preserve all game stat rows exactly')
  assert.equal(await sql(`SELECT is_current FROM league_seasons WHERE id='${oldSeason}'`), 'f')
  const domain = await assertDomain(c)
  report.actions.completed.push('playoff advancement; 48-hour grace; season rollover; synthetic rookie snake draft with a traded pick; all historical game stats preserved')
  return { passed: true, oldSeason, newSeason: c.leagueSeasonId, playoffGames: decided.length, rookiePicks: picks.length, historyPreserved: true, domain, rookieProvenance: 'SYNTHETIC: invented prospects enter through real sync-draft-order ingestion' }
}
