import assert from 'node:assert/strict'
import test from 'node:test'
import { assertPendingWaivers, readWaiverClaims } from './waiver-scenarios.mjs'

const members = ['a', 'b', 'c', 'd']
const claims = [
  { id: 'a1', member: 'a' }, { id: 'a2', member: 'a' },
  { id: 'b1', member: 'b' }, { id: 'c1', member: 'c' },
  { id: 'c2', member: 'c' }, { id: 'd1', member: 'd' },
]

test('pending claims are read through each owner under the production privacy policy', async () => {
  const reads = []
  const c = {
    users: [...members].reverse().map(memberId => ({ memberId })),
    rest: async (user, query) => {
      reads.push({ member: user.memberId, query })
      return claims.filter(row => row.member === user.memberId).map(row => ({ id: row.id, member_id: row.member, status: 'pending', processed_at: null, failure_reason: null }))
    },
  }
  const result = await readWaiverClaims(c, { seasonId: 'season', input: { claims } })
  assert.deepEqual(result.map(row => row.id).sort(), claims.map(row => row.id).sort())
  assert.equal(reads.length, 4)
  for (const read of reads) assert.ok(read.query.includes(`member_id=eq.${read.member}`))
})

test('the champion checkpoint rejects a missing claim and each changed pending field', async () => {
  const observed = claims.map(row => ({ id: row.id, member_id: row.member, status: 'pending', processed_at: null, failure_reason: null }))
  const scenario = { seasonId: 'season', input: { claims } }
  const context = rows => ({ users: members.map(memberId => ({ memberId })), rest: async user => rows.filter(row => row.member_id === user.memberId) })
  assert.ok((await assertPendingWaivers(context(observed), scenario)).passed)
  const corruptions = [
    rows => rows.pop(),
    rows => { rows[0].id = 'different' },
    rows => { rows[0].status = 'cancelled' },
    rows => { rows[0].processed_at = '2026-04-13T04:08:00Z' },
    rows => { rows[0].failure_reason = 'Unexpected cancellation' },
  ]
  for (const corrupt of corruptions) {
    const rows = structuredClone(observed)
    corrupt(rows)
    await assert.rejects(() => assertPendingWaivers(context(rows), scenario), /claim/)
  }
})
