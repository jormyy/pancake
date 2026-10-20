import assert from 'node:assert/strict'
import { expectedWinner } from './score-oracle.mjs'

export function rookieOrder(members, standings) {
  return members.map(memberId => {
    const latest = standings.filter(row => row.member_id === memberId).sort((a, b) => b.week_number - a.week_number)[0]
    return { memberId, hasStandings: latest ? 1 : 0, wins: Number(latest?.wins ?? 0), points: Number(latest?.points_for ?? 0) }
  }).sort((a, b) => b.hasStandings - a.hasStandings || a.wins - b.wins || a.points - b.points || a.memberId.localeCompare(b.memberId)).map(row => row.memberId)
}

export function checkDraftOrder({ picks, assets, expectedOrder, rounds }) {
  assert.equal(picks.length, expectedOrder.length * rounds, 'Complete rookie snake slots')
  for (const pick of picks) {
    const original = expectedOrder[pick.round % 2 ? pick.pick_in_round - 1 : expectedOrder.length - pick.pick_in_round]
    const asset = assets.find(row => row.id === pick.draft_pick_id)
    assert.ok(asset, 'Rookie slot references an allocated pick')
    assert.equal(asset.original_owner_id, original, 'Rookie snake order follows independent previous-season standings')
    assert.equal(pick.member_id, asset.current_owner_id, 'Rookie drafter follows traded pick ownership')
  }
}

export function checkAllocation(picks, members, year, rounds = 3) {
  const rows = picks.filter(pick => pick.season_year === year)
  assert.equal(rows.length, members.length * rounds, 'Every far-year pick is allocated exactly once')
  for (const member of members) for (let round = 1; round <= rounds; round++) assert.equal(rows.filter(pick => pick.original_owner_id === member && pick.round === round).length, 1, 'Allocation covers every team and round')
  return { year, teams: members.length, rounds, picks: rows.length, passed: true }
}

export function checkChampion(final, apiRow) {
  assert.ok(final?.is_finalized && final.winner_member_id, 'Production chain must finalize and name the champion')
  assert.equal(final.winner_member_id, expectedWinner(final), 'Champion follows independently determined playoff winner')
  assert.equal(apiRow?.winner_member_id, final.winner_member_id, 'Champion must be readable through the authenticated bracket query')
  assert.equal(apiRow?.is_finalized, true)
  return { matchupId: final.id, memberId: final.winner_member_id, passed: true }
}
