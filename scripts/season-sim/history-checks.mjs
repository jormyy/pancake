import assert from 'node:assert/strict'
import { sql } from './local-stack.mjs'

export async function verifyTimelineHistory(replay) {
  assert.match(replay.leagueId, /^[a-f0-9-]{36}$/)
  const members = JSON.parse(await sql(`SELECT json_agg(id) FROM league_members WHERE league_id='${replay.leagueId}'`))
  const processed = JSON.parse(await sql(`SELECT coalesce(json_agg(r),'[]') FROM (SELECT d.game_date,m.member_id,count(*) AS calls FROM lineup_tipoff_members m JOIN lineup_tipoff_dispatches d USING(tipoff_at) WHERE m.league_id='${replay.leagueId}' GROUP BY 1,2) r`))
  let preferenceComparisons = 0
  for (const day of replay.days.filter(day => day.finals.games > 0)) {
    for (const member of members) {
      const calls = Number(processed.find(row => row.game_date === day.date && row.member_id === member)?.calls ?? 0)
      if (day.lineups.disabledMembers.includes(member)) assert.equal(calls, 0, 'Disabled preference must exclude a member from every pre-tip worker')
      else assert.ok(calls > 0, `Enabled preference must reach pre-tip automation: ${day.date}/${member}`)
      preferenceComparisons++
    }
  }
  const now = await sql('SELECT now()')
  const cronJobs = Number(await sql('SELECT count(*) FROM cron.job'))
  assert.equal(cronJobs, 0)
  const balances = JSON.parse(await sql(`SELECT json_agg(r) FROM (SELECT b.member_id,b.league_season_id,b.balance,l.faab_starting_budget
    -coalesce((SELECT sum(w.bid_amount) FROM waiver_claims w WHERE w.league_season_id=b.league_season_id AND w.member_id=b.member_id AND w.status='succeeded'),0)
    +coalesce((SELECT sum(i.faab_amount) FROM trade_items i JOIN trades t ON t.id=i.trade_id WHERE t.league_season_id=b.league_season_id AND t.status='completed' AND i.to_member_id=b.member_id),0)
    -coalesce((SELECT sum(i.faab_amount) FROM trade_items i JOIN trades t ON t.id=i.trade_id WHERE t.league_season_id=b.league_season_id AND t.status='completed' AND i.from_member_id=b.member_id),0) AS expected
    FROM faab_balances b JOIN leagues l ON l.id=b.league_id WHERE b.league_id='${replay.leagueId}') r`))
  for (const balance of balances) assert.equal(balance.balance, balance.expected, 'FAAB equals the original budget plus completed transfers minus winning claims')
  const picks = JSON.parse(await sql(`SELECT json_agg(r) FROM (SELECT p.id,p.current_owner_id,coalesce((SELECT i.to_member_id FROM trade_items i JOIN trades t ON t.id=i.trade_id WHERE i.pick_id=p.id AND t.status='completed' ORDER BY t.completed_at DESC LIMIT 1),p.original_owner_id) AS expected FROM draft_picks p WHERE p.league_id='${replay.leagueId}') r`))
  for (const pick of picks) assert.equal(pick.current_owner_id, pick.expected, 'Pick ownership follows completed trades only')
  const newsRows = Number(await sql('SELECT count(*) FROM dynasty_news'))
  const nbaTeamChanges = replay.days.flatMap(day => day.nbaTeams?.changes ?? []).length
  if (replay.fullAcceptance) {
    assert.ok(replay.wallSeconds <= 43200, 'Full replay must finish within twelve hours')
  }
  return { preferenceComparisons, processedMemberDates: processed.length, faabComparisons: balances.length, pickChainComparisons: picks.length, newsRows, nbaTeamChanges, cronJobs, finalSimulatedTime: now, passed: true }
}
