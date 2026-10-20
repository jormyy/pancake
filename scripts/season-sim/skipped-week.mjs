import assert from 'node:assert/strict'
import { sqlJson } from './local-stack.mjs'

export function checkSkippedWeek({ matchups, lineups, standings, certificates, addCounts, expectedAdds, transactions, expectedTransactions, week }) {
  assert.equal(matchups.filter(row => row.week_number === week || row.week_number < week && row.end_week_number >= week).length, 0, `Skipped week ${week}: no matchup exists`)
  assert.equal(standings.filter(row => row.week_number === week).length, 0, `Skipped week ${week}: no standing is published`)
  assert.equal(certificates.filter(row => row.week_number === week).length, 0, `Skipped week ${week}: no score is certified`)
  assert.ok(Object.keys(expectedAdds).length > 0, `Skipped week ${week}: expected managers exist`)
  for (const [member, expected] of Object.entries(expectedAdds)) {
    const rows = addCounts.filter(row => row.member_id === member && row.week_number === week)
    assert.ok(rows.length <= 1, `Skipped week ${week}: add count is unique`)
    assert.equal(rows[0]?.add_count ?? 0, expected, `Skipped week ${week}: only genuine claims consume adds for ${member}`)
  }
  assert.ok(addCounts.every(row => Object.hasOwn(expectedAdds, row.member_id)), `Skipped week ${week}: add counts belong to expected managers`)
  const transactionKey = row => JSON.stringify([row.transaction_type, row.member_id, row.player_id, row.related_claim_id ?? null])
  assert.deepEqual(transactions.map(transactionKey).sort(), expectedTransactions.map(transactionKey).sort(), `Skipped week ${week}: only genuine manager actions change transactions`)
  return { week, matchups: 0, lineups: lineups.filter(row => row.week_number === week).length, standings: 0, certificates: 0, adds: expectedAdds, transactions: transactions.length, passed: true }
}

export function skippedWeekActions(c, week, now, startsAt, endsAt) {
  const expectedAdds = Object.fromEntries(c.users.map(user => [user.memberId, 0])), expectedTransactions = []
  const inside = at => at >= startsAt && at < endsAt && at <= now
  for (const add of c.waiverRosterAdds ?? []) if (add.seasonId === c.leagueSeasonId && inside(add.at)) {
    expectedAdds[add.member]++
    expectedTransactions.push({ transaction_type: 'fa_add', member_id: add.member, player_id: add.player, related_claim_id: null })
  }
  for (const scenario of c.waiverScenarios ?? []) {
    if (scenario.seasonId !== c.leagueSeasonId) continue
    for (const target of scenario.targets) if (inside(target.droppedAt)) {
      assert.ok(target.member, 'Scenario drop records its intended manager')
      expectedTransactions.push({ transaction_type: 'fa_drop', member_id: target.member, player_id: target.player, related_claim_id: null })
    }
    if (!inside(scenario.processAt)) continue
    for (const claim of scenario.input.claims) {
      if (scenario.expected.claims[claim.id] !== 'succeeded') continue
      expectedAdds[claim.member]++
      expectedTransactions.push({ transaction_type: 'waiver_add', member_id: claim.member, player_id: claim.player, related_claim_id: claim.id })
      if (claim.drop) expectedTransactions.push({ transaction_type: 'waiver_drop', member_id: claim.member, player_id: claim.drop, related_claim_id: claim.id })
    }
  }
  return { week, expectedAdds, expectedTransactions }
}

export async function assertSkippedWeek(c, week) {
  const read = async table => c.rest(c.users[0], `${table}?select=*&league_season_id=eq.${c.leagueSeasonId}&week_number=eq.${week}`)
  const accounting = await sqlJson(`SELECT json_build_object('now',extract(epoch FROM now())*1000,'startsAt',extract(epoch FROM (week_start::timestamp AT TIME ZONE 'America/New_York'))*1000,'endsAt',extract(epoch FROM ((week_end+1)::timestamp AT TIME ZONE 'America/New_York'))*1000,'certificates',(SELECT coalesce(json_agg(q),'[]') FROM private.score_week_certificates q WHERE league_season_id='${c.leagueSeasonId}' AND week_number=${week}),'addCounts',(SELECT coalesce(json_agg(q),'[]') FROM weekly_add_counts q WHERE league_season_id='${c.leagueSeasonId}' AND week_number=${week}),'transactions',(SELECT coalesce(json_agg(q),'[]') FROM roster_transactions q WHERE league_season_id='${c.leagueSeasonId}' AND occurred_at >= (week_start::timestamp AT TIME ZONE 'America/New_York') AND occurred_at < ((week_end+1)::timestamp AT TIME ZONE 'America/New_York'))) FROM season_weeks WHERE season_year=${c.seasonYear} AND week_number=${week}`, 'Skipped-week accounting')
  assert.ok(accounting, 'Skipped week requires a published calendar range')
  const [matchups, lineups, standings] = await Promise.all([c.rest(c.users[0], `matchups?select=*&league_season_id=eq.${c.leagueSeasonId}`), read('weekly_lineups'), read('standings')])
  return checkSkippedWeek({ ...accounting, ...skippedWeekActions(c, week, accounting.now, accounting.startsAt, accounting.endsAt), week, matchups, lineups, standings })
}

export async function isSkippedWeek(c, week) {
  const weeks = await sqlJson(`SELECT to_json(skipped_weeks) FROM league_seasons WHERE id='${c.leagueSeasonId}'`, 'Season skipped weeks')
  return weeks.includes(week)
}

export function checkNextSchedule(matchups, members, playoffStart, skippedWeeks) {
  const weeks = Array.from({ length: playoffStart - 1 }, (_, index) => index + 1).filter(week => !skippedWeeks.includes(week))
  assert.equal(matchups.length, weeks.length * members.length / 2, 'Next-season schedule keeps the configured playoff boundary')
  for (const week of weeks) {
    const rows = matchups.filter(row => row.week_number === week && row.matchup_type === 'regular_season' && !row.is_voided)
    assert.equal(rows.length, members.length / 2, `Eligible calendar week ${week} has every matchup`)
    assert.deepEqual(rows.flatMap(row => [row.home_member_id, row.away_member_id]).sort(), [...members].sort(), `Eligible calendar week ${week} uses every member once`)
  }
  return { passed: true, regularWeeks: weeks, playoffStart }
}
