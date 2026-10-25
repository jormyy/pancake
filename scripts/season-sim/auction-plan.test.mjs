import assert from 'node:assert/strict'
import test from 'node:test'
import {plannedAuctionBid} from './auction-plan.mjs'

test('manager bids spend the initial budget without assuming that optional taxi buying is unavailable',()=>{
  assert.deepEqual([0,1,2].map(count=>plannedAuctionBid(count)),[1,1,18])
})
