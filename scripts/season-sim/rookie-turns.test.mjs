import assert from'node:assert/strict'
import test from'node:test'
import{nextNotificationWindow}from'./rookie-turns.mjs'

test('sixty-second rookie turns resume before the real five-minute delivery gate',()=>{
  const at=Date.parse('2025-06-28T14:00:00Z'),window=nextNotificationWindow(at)
  assert.equal(window.dispatch-at,300000)
  assert.equal(window.dispatch-window.resume,15000)
  assert.ok(window.dispatch<window.resume+60000)
})
