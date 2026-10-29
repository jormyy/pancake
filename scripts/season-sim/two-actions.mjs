import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql, sqlJson } from './local-stack.mjs'
import { assertWeeklyAddLimit, nextWaiverRun } from './waiver-scenarios.mjs'
import { shiftDay } from './season-model.mjs'
import { waiverClaims, waiverResetAt } from './waiver-oracle.mjs'

const now = async () => Number(await sql('SELECT extract(epoch FROM now())*1000'))
const activeRoster = c => c.rest(c.users[0], `roster_players?select=*,players(nba_id)&league_season_id=eq.${c.leagueSeasonId}&is_on_ir=eq.false&is_on_taxi=eq.false`)

export function intendedOwner(c, playerId, at) {
  let owner = c.draftedRookies?.find(row => row.playerId === playerId)?.owner ?? null
  const moves = [...(c.identityMoves ?? []), ...(c.waiverRosterAdds ?? []).map(row => ({ playerId: row.player, owner: row.member, at: row.at }))]
  for (const scenario of c.waiverScenarios ?? []) {
    for (const row of scenario.targets) moves.push({ playerId: row.player, owner: null, at: row.droppedAt })
    for (const row of waiverClaims(scenario.input.claims, c.identityMoves, scenario.processAt)) if (scenario.expected.claims[row.id] === 'succeeded') {
      moves.push({ playerId: row.player, owner: row.member, at: scenario.processAt })
      if (row.drop) moves.push({ playerId: row.drop, owner: null, at: scenario.processAt })
    }
  }
  for (const row of moves.filter(row => row.playerId === playerId && row.at <= at).sort((a,b) => a.at-b.at)) owner = row.owner
  return owner
}

export async function activateRealRookies(c, plan, report) {
  const picks = await sqlJson(`SELECT json_agg(json_build_object('playerId',p.id,'pick',p.nba_draft_number,'owner',s.member_id)) FROM snake_draft_picks s JOIN players p ON p.id=s.player_id WHERE s.draft_id='${report.rookieAutoPick.draftId}'`, 'Real drafted rookie identities')
  assert.equal(picks.length, c.users.length * 2)
  c.draftedRookies = picks.map(row => {
    const real = plan.draft.rookies.find(real => real.pick === row.pick)
    assert.ok(real, 'Every fantasy rookie pick appears in the pinned real NBA draft board')
    return { ...row, nbaId: real.nbaId, name: real.name }
  })
  assert.equal(await sql("SELECT count(*) FROM players WHERE display_name LIKE 'Synthetic Prospect %'"), '0', 'The real leg never imports synthetic prospects')
  for (const user of c.users) {
    const rookies = c.draftedRookies.filter(row => row.owner === user.memberId)
    for (const rookie of rookies) {
      const active = (await activeRoster(c)).filter(row => row.member_id === user.memberId)
      if (active.length >= 3) {
        const drop = active.find(row => !c.draftedRookies.some(rookie => rookie.playerId === row.player_id))
        assert.ok(drop, 'Real rookie activation has a genuine veteran roster slot')
        await c.rpc(user, 'drop_player_atomic', { p_roster_player_id: drop.id, p_expected_league_season_id: c.leagueSeasonId })
      }
      const row = (await c.rest(user, `roster_players?select=*&league_season_id=eq.${c.leagueSeasonId}&player_id=eq.${rookie.playerId}`))[0]
      assert.ok(row, 'A drafted rookie remains on its fantasy roster after rollover')
      if (row.is_on_taxi) await c.api(user, '/league/roster/taxi', { rosterPlayerId: row.id, isOnTaxi: false })
    }
  }
  report.realRookieActivation = { passed: true, rookies: c.draftedRookies, provenance: 'REAL-RAW NBA draft identities; SYNTHETIC authenticated fantasy selections and roster actions' }
}

// Every real NBA box listing of a real draftee: his team is the box side that lists him, inactive listings included.
export async function rookieListings(rookies, games, boxOf) {
  const ids = new Set(rookies.flatMap(rookie => rookie.gameIds)), listings = []
  for (const game of games.filter(row => ids.has(row.id))) {
    const box = await boxOf(game.id)
    for (const [team, side] of [[game.home, box.game.homeTeam], [game.away, box.game.awayTeam]]) for (const player of side.players) {
      if (rookies.some(rookie => rookie.nbaId === String(player.personId))) listings.push({ nbaId: String(player.personId), gameId: game.id, date: game.date, time: game.time, team, played: player.played })
    }
  }
  return listings
}

// A draftee whose real boxes list him for a second team (Walter Clayton Jr. UTA to MEM on 2026-02-04, INACTIVE_TRADE; John
// Tonje UTA to BOS on 2026-02-06, two-way) moves like a deadline trade subject: his fantasy owner keeps the same row and he
// scores for the new team. The move is his first listing for another team; firstAfter is his first played game for it.
export function rookieMoves(rookies, listings, year) {
  const moves = []
  for (const rookie of rookies) {
    const rows = listings.filter(row => row.nbaId === rookie.nbaId).sort((a, b) => a.time.localeCompare(b.time))
    const at = rows.findIndex((row, index) => index > 0 && row.team !== rows[index - 1].team)
    if (at < 0) continue
    const to = rows[at].team, stay = rows.slice(at), end = stay.findIndex(row => row.team !== to)
    const firstAfter = (end < 0 ? stay : stay.slice(0, end)).find(row => row.played === '1')?.date
    if (firstAfter) moves.push({ year, nbaId: rookie.nbaId, name: rookie.name, from: rows[at - 1].team, to, movedOn: rows[at].date, firstAfter, source: `boxscore-${rows[at].gameId}`, provenance: 'REAL-RAW NBA box listings of a real draftee' })
  }
  return moves
}

export async function nbaTradeSetup(c, date, plan, moves = []) {
  if (date !== `${c.seasonYear}-01-01`) return
  const subjects = [...plan.nbaTrades, ...moves].filter(row => row.year === c.seasonYear)
  assert.ok(plan.nbaTrades.some(row => row.year === c.seasonYear), 'A raw-box-confirmed NBA deadline trade subject exists')
  c.nbaTradeSubjects ??= []
  for (const subject of subjects) {
    const player = (await c.rest(c.users[0], `players?select=id,nba_id&nba_id=eq.${subject.nbaId}`))[0]
    assert.ok(player, 'NBA deadline subject exists before the real trade')
    let roster = await activeRoster(c), owned = roster.find(row => row.player_id === player.id)
    if (!owned) {
      // Each subject goes to a member who holds no other subject this season, so no two compete for one owner's starts.
      const held = c.nbaTradeSubjects.filter(row => row.year === c.seasonYear), veteran = row => !c.draftedRookies?.some(rookie => rookie.playerId === row.player_id) && !held.some(subject => subject.playerId === row.player_id)
      const drop = roster.find(row => veteran(row) && !held.some(subject => subject.owner === row.member_id)) ?? roster.find(veteran)
      assert.ok(drop, 'NBA trade continuity uses a genuine veteran roster slot')
      const user = c.users.find(row => row.memberId === drop.member_id)
      await c.rpc(user, 'drop_player_atomic', { p_roster_player_id: drop.id, p_expected_league_season_id: c.leagueSeasonId })
      await c.rpc(user, 'add_free_agent_atomic', { p_member_id: user.memberId, p_league_id: c.leagueId, p_player_id: player.id })
      roster = await activeRoster(c)
      owned = roster.find(row => row.player_id === player.id)
    }
    assert.ok(owned)
    c.nbaTradeSubjects.push({ ...subject, playerId: player.id, owner: owned.member_id, at: date })
  }
}

export async function allStarLimit(c, date, profile, report) {
  const merged = profile.calendar.weeks.find(row => row.week_start <= profile.calendar.gap.before && row.week_end >= profile.calendar.gap.after)
  if (date === shiftDay(merged.week_start, 1)) {
    const roster = await activeRoster(c), drop = roster.find(row => !c.draftedRookies?.some(rookie => rookie.playerId === row.player_id) && !c.nbaTradeSubjects?.some(subject => subject.playerId === row.player_id))
    assert.ok(drop, 'Merged-week limit scenario has a genuine veteran roster slot')
    const user = c.users.find(row => row.memberId === drop.member_id)
    const playerId = await sql(`SELECT id FROM players p WHERE nba_id IS NOT NULL AND position IS NOT NULL AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id='${c.leagueId}' AND r.player_id=p.id) AND NOT EXISTS(SELECT 1 FROM waiver_wire_log w WHERE w.league_id='${c.leagueId}' AND w.player_id=p.id AND cleared_at IS NULL) ORDER BY nba_id LIMIT 1`)
    await c.rpc(user, 'drop_player_atomic', { p_roster_player_id: drop.id, p_expected_league_season_id: c.leagueSeasonId })
    await c.rpc(user, 'add_free_agent_atomic', { p_member_id: user.memberId, p_league_id: c.leagueId, p_player_id: playerId })
    c.allStarLimit = { year: profile.year, member: user.memberId, week: merged.week_number, addedPlayer: playerId, began: date }
  }
  if (date === profile.calendar.gap.after) {
    assert.ok(c.allStarLimit?.year === profile.year, 'The pre-break add actually ran')
    const user = c.users.find(row => row.memberId === c.allStarLimit.member)
    const state = (await c.rpc(user, 'get_member_transaction_state', { p_member_id: user.memberId, p_league_id: c.leagueId }))[0]
    assert.equal(state.week_number,merged.week_number,'The merged matchup retains one add bucket')
    assert.equal(Date.parse(state.add_limit_resets_at),waiverResetAt(merged.week_end),'The add bucket ends after the complete merged matchup')
    assert.equal(state.weekly_add_count, 1, 'No add-limit reset occurs inside the merged All-Star matchup')
    await assertWeeklyAddLimit(c, user, await sql(`SELECT id FROM players p WHERE nba_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id='${c.leagueId}' AND r.player_id=p.id) AND NOT EXISTS(SELECT 1 FROM waiver_wire_log w WHERE w.league_id='${c.leagueId}' AND w.player_id=p.id AND cleared_at IS NULL) ORDER BY nba_id LIMIT 1`))
    report.allStarLimits ??= []
    report.allStarLimits.push({ ...c.allStarLimit, checked: date, resetsAt: new Date(waiverResetAt(merged.week_end)).toISOString(), passed: true })
  }
}

export async function realRookieActions(c, date, move, report) {
  if (!c.draftedRookies) return
  c.identityMoves ??= []
  report.realRookieActions ??= {}
  if (date === (c.rookieActionDates?.trade??`${c.seasonYear}-01-07`)) {
    const roster = await activeRoster(c), offer = roster.find(row => c.draftedRookies.some(rookie => rookie.playerId === row.player_id))
    assert.ok(offer,'A real rookie remains available for its planned mid-season trade')
    const counter = roster.find(row => row.member_id !== offer.member_id && !c.draftedRookies.some(rookie => rookie.playerId === row.player_id) && !c.nbaTradeSubjects?.some(subject=>subject.playerId===row.player_id))
    assert.ok(offer && counter, 'Mid-season rookie trade has two real active assets')
    const from = c.users.find(row => row.memberId === offer.member_id), to = c.users.find(row => row.memberId === counter.member_id)
    const proposed = await c.api(from, '/trades/propose', { requestId: randomUUID(), leagueId: c.leagueId, leagueSeasonId: c.leagueSeasonId, memberId: from.memberId, recipientMemberId: to.memberId, offerPlayerIds: [offer.player_id], requestPlayerIds: [counter.player_id] })
    await c.api(to, `/trades/${proposed.tradeId}/accept`, { memberId: to.memberId })
    await move(await now() + 6*60000)
    assert.equal(await sql(`SELECT status FROM trades WHERE id='${proposed.tradeId}'`), 'completed')
    const at = await now()
    c.identityMoves.push({ playerId: offer.player_id, owner: to.memberId, at }, { playerId: counter.player_id, owner: from.memberId, at })
    assert.equal((await activeRoster(c)).find(row => row.player_id === offer.player_id)?.member_id, to.memberId)
    report.realRookieActions.trade = { passed: true, tradeId: proposed.tradeId, playerId: offer.player_id, owner: to.memberId, at }
  }
  if (date === (c.rookieActionDates?.drop??`${c.seasonYear}-01-09`)) {
    const roster = await activeRoster(c), drop = roster.find(row => c.draftedRookies.some(rookie => rookie.playerId === row.player_id) && row.player_id !== report.realRookieActions.trade?.playerId)
    assert.ok(drop, 'A second real rookie exercises drop and waiver re-add')
    const user = c.users.find(row => row.memberId === drop.member_id), at = await now()
    await c.rpc(user, 'drop_player_atomic', { p_roster_player_id: drop.id, p_expected_league_season_id: c.leagueSeasonId })
    c.identityMoves.push({ playerId: drop.player_id, owner: null, at })
    const response = await c.api(user, '/waivers/claims', { memberId: user.memberId, leagueId: c.leagueId, playerId: drop.player_id, bidAmount: 0 })
    assert.ok(response)
    const claim = (await c.rest(user, `waiver_claims?select=*&league_season_id=eq.${c.leagueSeasonId}&player_id=eq.${drop.player_id}&member_id=eq.${user.memberId}&status=eq.pending`))[0]
    assert.ok(claim)
    const processAt = nextWaiverRun(at + 48*3600000,await sql(`SELECT coalesce(timezone,'America/Los_Angeles') FROM leagues WHERE id='${c.leagueId}'`))
    c.identityMoves.push({ playerId: drop.player_id, owner: user.memberId, at: processAt })
    c.rookieReadd = { claimId: claim.id, playerId: drop.player_id, owner: user.memberId, processAt }
  }
  if (c.rookieReadd && !report.realRookieActions.readd && await now() >= c.rookieReadd.processAt) {
    const { claimId, playerId, owner, processAt } = c.rookieReadd
    const claim = (await c.rest(c.users.find(row => row.memberId === owner), `waiver_claims?select=*&id=eq.${claimId}`))[0]
    assert.equal(claim?.status, 'succeeded', 'Real dropped rookie re-enters through the production waiver worker')
    assert.equal(Date.parse(claim.processed_at), processAt)
    assert.equal((await activeRoster(c)).find(row => row.player_id === playerId)?.member_id, owner)
    report.realRookieActions.readd = { passed: true, ...c.rookieReadd }
  }
}

// Two starters: an NBA-moved subject due for its first start for the new team first, then the listed watched players, then
// other NBA players; the measured bench rookie sits.
export function rookieStarters(rookies, active, bench, due = []) {
  const listed = rookies.filter(row => row.player_id !== bench)
  return [...listed.filter(row => due.includes(row.player_id)), ...listed.filter(row => !due.includes(row.player_id)), ...active.filter(row => !rookies.includes(row) && row.players?.nba_id != null)].slice(0, 2)
}

export async function rookieLineups(c, date, week, today, store, report, clock = now) {
  const watched=[...(c.draftedRookies??[]),...(c.nbaTradeSubjects??[]).filter(row=>row.year===c.seasonYear&&!row.verified)]
  if (!watched.length) return
  const at = await clock(), roster = await activeRoster(c), playing = new Set()
  for (const game of today) {
    const box = await store.json(`boxscore-${game.id}`)
    for (const row of [...box.game.homeTeam.players,...box.game.awayTeam.players]) playing.add(String(row.personId))
  }
  c.rookiePreferences ??= []
  for (const rookie of c.draftedRookies??[]) {
    const owner = intendedOwner(c, rookie.playerId, at)
    const actual = roster.find(row => row.player_id === rookie.playerId)
    assert.equal(actual?.member_id ?? null, owner, 'A drafted rookie is never lost from the intended fantasy owner')
  }
  for (const user of c.users) {
    const active = roster.filter(row => row.member_id === user.memberId)
    const rookies = active.filter(row => watched.some(rookie => rookie.playerId === row.player_id && playing.has(rookie.nbaId)))
    if (!rookies.length) continue
    await c.restWrite(user, `lineup_optimizer_settings?league_season_id=eq.${c.leagueSeasonId}&member_id=eq.${user.memberId}`, { enabled: false }, 'PATCH')
    const bench = !report.realRookieActions?.bench ? rookies.find(row=>c.draftedRookies?.some(rookie=>rookie.playerId===row.player_id))?.player_id??null : null
    const starters = rookieStarters(rookies, active, bench, (c.nbaTradeSubjects ?? []).filter(row => row.year === c.seasonYear && !row.verified && date >= row.firstAfter).map(row => row.playerId))
    await c.rpc(user, 'set_player_slot_moves_atomic', { p_member_id: user.memberId, p_league_id: c.leagueId, p_league_season_id: c.leagueSeasonId, p_game_date: date, p_week_number: week, p_moves: active.map(row => ({ player_id: row.player_id, slot_type: starters.includes(row) ? 'UTIL' : 'BE' })) })
    for (const row of rookies) c.rookiePreferences.push({ date, playerId: row.player_id, nbaId: watched.find(rookie => rookie.playerId === row.player_id).nbaId, owner: user.memberId, starter: starters.includes(row) })
    if (bench) { report.realRookieActions ??= {}; report.realRookieActions.bench = { date, playerId: bench, measured: false } }
  }
}
