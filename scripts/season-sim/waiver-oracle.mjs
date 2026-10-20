import assert from 'node:assert/strict'

export function waiverOutcomes({ claims, mode, priorities, budgets, rosterCounts, weeklyCounts, limit, rosterSize }) {
  const result = { priorities: { ...priorities }, budgets: { ...budgets }, rosterCounts: { ...rosterCounts }, weeklyCounts: { ...weeklyCounts }, claims: {} }
  const pending = [...claims], awarded = new Set()
  while (pending.length) {
    pending.sort((a, b) => (mode === 'faab' ? b.bid - a.bid : 0) || result.priorities[a.member] - result.priorities[b.member] || a.order - b.order || a.submitted.localeCompare(b.submitted) || a.id.localeCompare(b.id))
    const claim = pending.shift(), member = claim.member, bid = mode === 'faab' ? claim.bid : 0
    let status = 'succeeded'
    if (awarded.has(claim.player)) status = 'failed_priority'
    else if (result.weeklyCounts[member] >= limit) status = 'failed_roster'
    else if (result.budgets[member] < bid) status = 'failed_priority'
    else if (result.rosterCounts[member] + 1 - Number(!!claim.drop) > rosterSize) status = 'failed_roster'
    result.claims[claim.id] = status
    if (status !== 'succeeded') continue
    awarded.add(claim.player)
    result.budgets[member] -= bid
    result.rosterCounts[member] += 1 - Number(!!claim.drop)
    result.weeklyCounts[member]++
    result.priorities[member] = Math.max(...Object.values(result.priorities)) + 1
  }
  return result
}

export function checkWaiverResult(expected, observed) {
  for (const [id, status] of Object.entries(expected.claims)) assert.equal(observed.claims.find(row => row.id === id)?.status, status, `Waiver claim ${id}: independent award rule`)
  for (const member of Object.keys(expected.priorities)) {
    assert.equal(observed.priorities.find(row => row.member_id === member)?.priority, expected.priorities[member], `Waiver priority ${member}`)
    assert.equal(observed.states[member].faab_balance, expected.budgets[member], `FAAB balance ${member}`)
    assert.equal(observed.states[member].weekly_add_count, expected.weeklyCounts[member], `Weekly add count ${member}`)
    assert.equal(observed.rosterCounts[member], expected.rosterCounts[member], `Waiver roster count ${member}`)
  }
  return { claims: Object.keys(expected.claims).length, members: Object.keys(expected.priorities).length, passed: true }
}

export function rolloverPriorities(members, standings) {
  const latest = new Map()
  for (const row of standings) if (!latest.has(row.member_id) || latest.get(row.member_id).week_number < row.week_number) latest.set(row.member_id, row)
  const value = (member, key) => Number(latest.get(member)?.[key] ?? 0)
  const ordered = [...members].sort((a, b) => value(a, 'wins') - value(b, 'wins') || value(a, 'points_for') - value(b, 'points_for') || value(b, 'losses') - value(a, 'losses') || value(b, 'points_against') - value(a, 'points_against') || a.localeCompare(b))
  return Object.fromEntries(ordered.map((member, index) => [member, index + 1]))
}

export function checkWaiverTiming(processedAt, expectedAt) {
  assert.equal(Date.parse(processedAt), expectedAt, 'Due waiver claim processes at the production 03:00 Eastern gate')
  return true
}

export function waiverParticipants(users, priorities, rosters, rosterSize) {
  const ordered = [...users].sort((a, b) => priorities[a.memberId] - priorities[b.memberId])
  const claimant = ordered.find(user => rosters[user.memberId].length === rosterSize)
  assert.ok(claimant, 'Full-roster failure requires an actual full roster')
  return [claimant, ...ordered.filter(user => user.memberId !== claimant.memberId)]
}
