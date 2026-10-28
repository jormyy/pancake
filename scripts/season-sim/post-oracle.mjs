import assert from 'node:assert/strict'
import { etDate } from './common.mjs'
import { expectedWinner } from './score-oracle.mjs'
import { rookiePickOrder } from './official-outcomes.mjs'

export { rookieOrder } from './official-outcomes.mjs'

export function checkDraftOrder({ picks, assets, expectedOrder, rounds, orderType = 'linear' }) {
  assert.equal(picks.length, expectedOrder.length * rounds, 'Complete rookie draft slots')
  for (const pick of picks) {
    const original = rookiePickOrder(expectedOrder, pick.round, orderType)[pick.pick_in_round - 1]
    const asset = assets.find(row => row.id === pick.draft_pick_id)
    assert.ok(asset, 'Rookie slot references an allocated pick')
    assert.equal(asset.original_owner_id, original, 'Rookie draft order follows independent previous-season standings')
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

export function checkPlayoffShape(matchups,entrants,start,lengths,calendar){
  let first=start
  for(const [index,length] of lengths.entries()){
    const rows=matchups.filter(row=>row.playoff_round===index+1)
    assert.equal(rows.length,entrants/2**(index+1),'Automatic bracket has the configured round size')
    for(const row of rows){
      assert.equal(row.week_number,first,'Automatic round starts in its configured fantasy week')
      assert.equal(row.end_week_number,first+length-1,'Multi-week playoff span matches its settings')
      assert.ok(row.is_finalized&&row.winner_member_id,'Every playoff matchup automatically finalizes')
      assert.equal(row.winner_member_id,expectedWinner(row),'Every playoff winner follows independent points and tie rules')
      if(index){
        const previous=matchups.filter(prior=>prior.playoff_round===index)
        for(const member of [row.home_member_id,row.away_member_id])assert.ok(previous.some(prior=>prior.winner_member_id===member),'Only previous-round winners advance')
        checkRoundReady(row.created_at, previous, calendar)
      }
    }
    first+=length
  }
  assert.equal(matchups.length,entrants-1,'No extra playoff matchup exists')
  return {passed:true,entrants,start,lengths,matchups:matchups.length}
}

export function checkRealDraftBoard(rookies,players){
  const name=value=>value.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]/g,'')
  assert.equal(players.length,rookies.length,'The product imports the complete pinned real draft board')
  for(const rookie of rookies){
    const rows=players.filter(row=>row.nba_draft_number===rookie.pick)
    assert.equal(rows.length,1,'Every raw NBA draft number maps to one player')
    assert.equal(name(rows[0].display_name),name(rookie.name),'Draft import names agree with the independent NBA Stats board')
    assert.equal(rows[0].years_exp,0,'The imported real draft class is rookie eligible')
    assert.equal(rows[0].nba_id,null,'Name-only draft imports stay unlinked before the first NBA observation')
  }
  return {passed:true,players:players.length,provenance:'REAL-RAW NBA Stats board compared with the NBA.com production import'}
}

export function checkRoundReady(createdAt, prerequisites, calendar) {
  assert.ok(prerequisites.length, 'A bracket requires preceding matchups')
  const lastWeek = Math.max(...prerequisites.map(row => row.end_week_number ?? row.week_number))
  const lastGameDate = calendar.weeks.find(row => row.week_number === lastWeek)?.week_end
  assert.ok(lastGameDate, 'A bracket requires the preceding round calendar')
  assert.ok(prerequisites.every(row => row.is_finalized), 'A bracket requires finalized preceding matchups')
  assert.ok(etDate(createdAt) > lastGameDate, 'A bracket waits until the Eastern date passes the last game date')
}
