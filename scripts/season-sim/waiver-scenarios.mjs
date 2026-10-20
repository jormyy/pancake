import assert from 'node:assert/strict'
import { etDate } from './common.mjs'
import { sql } from './local-stack.mjs'
import { checkPendingWaivers, checkWaiverResult, checkWaiverTiming, rolloverPriorities, waiverOutcomes, waiverParticipants } from './waiver-oracle.mjs'

const roster = (c, user) => c.rest(user, `roster_players?select=*&league_season_id=eq.${c.leagueSeasonId}&member_id=eq.${user.memberId}&is_on_ir=eq.false&is_on_taxi=eq.false&order=player_id`)
const transactionState = async (c, user) => (await c.rpc(user, 'get_member_transaction_state', { p_member_id: user.memberId, p_league_id: c.leagueId }))[0]
const freePlayer = c => sql(`SELECT id FROM players p WHERE p.nba_id IS NOT NULL AND p.position IS NOT NULL AND p.injury_status IS NULL AND NOT EXISTS(SELECT 1 FROM roster_players r WHERE r.league_id='${c.leagueId}' AND r.player_id=p.id) AND NOT EXISTS(SELECT 1 FROM waiver_wire_log w WHERE w.league_id='${c.leagueId}' AND w.player_id=p.id AND w.cleared_at IS NULL) ORDER BY nba_id LIMIT 1`)

export function nextWaiverRun(clearsAt) {
  let date = etDate(new Date(clearsAt).toISOString())
  const atThree = day => {
    const offset = new Intl.DateTimeFormat('en', { timeZone: 'America/New_York', timeZoneName: 'longOffset' }).formatToParts(new Date(`${day}T12:00:00Z`)).find(part => part.type === 'timeZoneName').value.replace('GMT', '')
    return Date.parse(`${day}T03:00:00${offset}`)
  }
  if (atThree(date) < clearsAt) date = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)
  return atThree(date)
}

export async function beginWaivers(c, name, report) {
  c.waiverScenarios ??= []
  if (c.waiverScenarios.some(row => row.name === name)) return
  const mode = await sql(`SELECT waiver_mode FROM leagues WHERE id='${c.leagueId}'`)
  const priorities = c.expectedWaiverPriorities ?? Object.fromEntries(c.users.map((user, index) => [user.memberId, index + 1]))
  const initialRosters = Object.fromEntries(await Promise.all(c.users.map(async user => [user.memberId, await roster(c, user)])))
  const users = waiverParticipants(c.users, priorities, initialRosters, 3)
  const [a, b, donorC, donorD] = users
  assert.equal(users.length, 4, 'The declared waiver scenario uses four managers')
  assert.equal(initialRosters[a.memberId].length, 3, 'Full-roster failure needs a full claimant roster')
  const targets = []
  for (const donor of [donorD, donorC]) {
    const row = initialRosters[donor.memberId][0]
    assert.ok(row, 'Waiver donor has an active player')
    const at = Number(await sql('SELECT extract(epoch FROM now())*1000'))
    await c.rpc(donor, 'drop_player_atomic', { p_roster_player_id: row.id, p_expected_league_season_id: c.leagueSeasonId })
    const hold = (await c.rest(donor, `waiver_wire_log?select=*&league_season_id=eq.${c.leagueSeasonId}&player_id=eq.${row.player_id}&cleared_at=is.null`))[0]
    assert.ok(hold, 'A genuine drop creates a waiver hold')
    assert.equal(Date.parse(hold.clears_at), at + 48 * 3600000, 'Drop hold lasts exactly 48 hours')
    targets.push({ player: row.player_id, clearsAt: at + 48 * 3600000 })
  }
  const active = Object.fromEntries(await Promise.all(users.map(async user => [user.memberId, await roster(c, user)])))
  if (mode === 'faab') {
    const rejected = await c.api(a, '/waivers/claims', { memberId: a.memberId, leagueId: c.leagueId, playerId: targets[0].player, bidAmount: 101 }, 400)
    assert.match(JSON.stringify(rejected), /balance|FAAB/i)
  }
  const budgets = c.expectedWaiverBudgets ?? Object.fromEntries(users.map(user => [user.memberId, 100]))
  const plans = [
    [a, targets[0], Math.min(80, budgets[a.memberId]), false], [b, targets[0], 30, true], [donorC, targets[0], 20, true],
    [a, targets[1], 10, true], [donorC, targets[1], 10, true], [donorD, targets[1], 10, true],
  ]
  const claims = [], orders = {}
  for (const [user, target, bid, drop] of plans) {
    const dropPlayer = drop ? active[user.memberId][0]?.player_id : null
    assert.ok(!drop || dropPlayer, 'Conditional waiver drop exists')
    await c.api(user, '/waivers/claims', { memberId: user.memberId, leagueId: c.leagueId, playerId: target.player, dropPlayerId: dropPlayer, bidAmount: bid })
    const claim = (await c.rest(user, `waiver_claims?select=*&league_season_id=eq.${c.leagueSeasonId}&member_id=eq.${user.memberId}&player_id=eq.${target.player}&status=eq.pending`))[0]
    assert.ok(claim, 'Claim submission persists a pending claim')
    const order = (orders[user.memberId] ?? 0) + 1
    orders[user.memberId] = order
    assert.equal(claim.claim_order, order)
    assert.equal(claim.bid_amount, mode === 'faab' ? bid : 0, 'Rolling claims ignore entered FAAB amounts')
    claims.push({ id: claim.id, member: user.memberId, player: target.player, bid, drop: dropPlayer, order, submitted: claim.submitted_at })
  }
  const input = { claims, mode, priorities, budgets, rosterCounts: Object.fromEntries(users.map(user => [user.memberId, active[user.memberId].length])), weeklyCounts: Object.fromEntries(users.map(user => [user.memberId, 0])), limit: 1, rosterSize: 3 }
  const scenario = { name, mode, seasonId: c.leagueSeasonId, targets, input, expected: waiverOutcomes(input), processAt: nextWaiverRun(Math.max(...targets.map(row => row.clearsAt))), checked: false }
  c.waiverScenarios.push(scenario)
  report.waivers ??= []
  report.waivers.push(scenario)
}

export async function verifyWaivers(c, report) {
  const now = Number(await sql('SELECT extract(epoch FROM now())*1000'))
  for (const scenario of c.waiverScenarios ?? []) {
    if (scenario.checked || scenario.seasonId !== c.leagueSeasonId || now < scenario.processAt) continue
    const claims = await readWaiverClaims(c, scenario)
    const priorities = await c.rest(c.users[0], `waiver_priorities?select=*&league_season_id=eq.${c.leagueSeasonId}`)
    const states = Object.fromEntries(await Promise.all(c.users.map(async user => [user.memberId, await transactionState(c, user)])))
    const rosterCounts = Object.fromEntries(await Promise.all(c.users.map(async user => [user.memberId, (await roster(c, user)).length])))
    scenario.result = checkWaiverResult(scenario.expected, { claims, priorities, states, rosterCounts })
    for (const claim of scenario.input.claims) {
      const actual = claims.find(row => row.id === claim.id)
      checkWaiverTiming(actual.processed_at, scenario.processAt)
    }
    const winner = c.users.find(user => scenario.expected.weeklyCounts[user.memberId] === 1)
    const rejected = await c.rpc(winner, 'add_free_agent_atomic', { p_member_id: winner.memberId, p_league_id: c.leagueId, p_player_id: await freePlayer(c) }, 400)
    assert.match(JSON.stringify(rejected), /Weekly add limit/i)
    scenario.checked = true
    scenario.checkedAt = new Date(now).toISOString()
    scenario.awardWeek = states[winner.memberId].week_number
    c.expectedWaiverPriorities = scenario.expected.priorities
    c.expectedWaiverBudgets = scenario.expected.budgets
    report.waivers ??= []
    if (!report.waivers.some(row => row.name === scenario.name)) report.waivers.push(scenario)
  }
}

export async function assertWaiverReset(c) {
  for (const user of c.users) {
    const state = await transactionState(c, user)
    assert.equal(state.weekly_add_count, 0, 'The first eligible week starts with a fresh add limit')
  }
}

export async function assertWaiverRollover(c, oldSeason, report) {
  const standings = await c.rest(c.users[0], `standings?select=*&league_season_id=eq.${oldSeason}`)
  const expected = rolloverPriorities(c.users.map(user => user.memberId), standings)
  const observed = await c.rest(c.users[0], `waiver_priorities?select=*&league_season_id=eq.${c.leagueSeasonId}`)
  for (const user of c.users) {
    assert.equal(observed.find(row => row.member_id === user.memberId)?.priority, expected[user.memberId], 'New-season waiver order follows independent reverse standings')
    const state = await transactionState(c, user)
    assert.equal(state.faab_balance, 100, 'New season starts with the configured FAAB budget')
    assert.equal(state.weekly_add_count, 0, 'Rollover resets add counts in the new season')
  }
  c.expectedWaiverPriorities = expected
  c.expectedWaiverBudgets = Object.fromEntries(c.users.map(user => [user.memberId, 100]))
  report.waiverRollover = { passed: true, priorities: expected, faab: 100, weeklyAdds: 0 }
}

export async function readWaiverClaims(c, scenario) {
  const ids = scenario.input.claims.map(row => row.id)
  const owners = [...new Set(scenario.input.claims.map(row => row.member))]
  const rows = await Promise.all(owners.map(member => {
    const user = c.users.find(row => row.memberId === member)
    assert.ok(user, 'Every waiver claim has an authenticated owner')
    return c.rest(user, `waiver_claims?select=*&league_season_id=eq.${scenario.seasonId}&member_id=eq.${member}&id=in.(${ids.join(',')})`)
  }))
  return rows.flat()
}

export async function assertPendingWaivers(c, scenario) {
  return checkPendingWaivers(scenario.input.claims, await readWaiverClaims(c, scenario))
}
