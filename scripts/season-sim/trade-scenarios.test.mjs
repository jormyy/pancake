import assert from 'node:assert/strict'
import test from 'node:test'
import { futureRecipientPick } from './trade-scenarios.mjs'

test('trade scenarios use a real asset within a three-year pick window',()=>{
  const picks=[{id:'next',season_year:2028,round:1},{id:'far-second',season_year:2030,round:2},{id:'far-first',season_year:2030,round:1}]
  assert.equal(futureRecipientPick(picks,2027),'next')
  assert.equal(futureRecipientPick(picks.filter(pick=>pick.id!=='next'),2027),'far-first')
  assert.equal(picks[0].id,'next')
})

test('trade scenarios never invent an absent future pick',()=>{
  assert.equal(futureRecipientPick([],2027),null)
  assert.equal(futureRecipientPick([{id:'old',season_year:2027,round:1}],2027),null)
  assert.equal(futureRecipientPick([{id:'later',season_year:2028,round:1}],2027),'later')
})
