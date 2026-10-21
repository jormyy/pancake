import assert from'node:assert/strict'
import test from'node:test'
import{observedSeasonOrder,playerAverages}from'./feature-evidence.mjs'

test('persisted season ordering is observed without importing product shuffle code',()=>{
  const members=[{id:'a'},{id:'b'}]
  assert.deepEqual(observedSeasonOrder({matchup_order_member_ids:['b','a']},members),['b','a'])
  assert.equal(observedSeasonOrder({playoff_bracket_seed_ids:['b','a']},members),null)
  assert.equal(observedSeasonOrder({matchup_order_member_ids:['a','a']},members),null)
})

test('F3 averages rebuild from played stat lines and ignore DNP rows',()=>{
  assert.deepEqual(playerAverages([{player_id:'p',points:10,did_not_play:false},{player_id:'p',points:20,did_not_play:false},{player_id:'p',points:99,did_not_play:true}],{points:1}),{p:15})
})

test('negative half-cent Players averages round away from zero',()=>{
  assert.equal(playerAverages([{player_id:'p',points:1},{player_id:'p',points:2}],{points:-0.01}).p,-0.02)
})
