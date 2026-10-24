import assert from 'node:assert/strict'

export function waiverClaims(claims, moves = [], at = Infinity) {
  return claims.map(claim => claim.drop && moves.some(move => move.playerId === claim.drop && move.owner !== claim.member && move.at > Date.parse(claim.submitted) && move.at <= at) ? { ...claim, drop: null } : claim)
}

export function waiverOutcomes({ claims, mode, priorities, budgets, rosterCounts, weeklyCounts, limit, rosterSize }, { moves = [], at = Infinity } = {}) {
  const result = { priorities: { ...priorities }, budgets: { ...budgets }, rosterCounts: { ...rosterCounts }, weeklyCounts: { ...weeklyCounts }, claims: {} }
  const pending = waiverClaims(claims, moves, at), awarded = new Set()
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

export function checkPendingWaivers(expected, observed) {
  assert.equal(observed.length, expected.length, 'Every expected pending claim remains readable through its owner')
  assert.equal(new Set(observed.map(row => row.id)).size, expected.length, 'Pending claim observations are unique')
  for (const claim of expected) {
    const actual = observed.find(row => row.id === claim.id)
    assert.ok(actual, `Pending claim ${claim.id} exists`)
    assert.equal(actual.member_id, claim.member, `Pending claim ${claim.id} keeps its owner`)
    assert.equal(actual.status, 'pending', `Final finalization preserves pending claim ${claim.id}`)
    assert.equal(actual.processed_at, null, `Pending claim ${claim.id} has no processing time`)
    assert.equal(actual.failure_reason, null, `Pending claim ${claim.id} has no failure reason`)
  }
  return { passed: true, claims: observed.map(({ id, member_id, status, process_date, processed_at, failure_reason }) => ({ id, member_id, status, process_date, processed_at, failure_reason })) }
}

export function waiverResetAt(weekEnd) {
  const next = new Date(Date.parse(`${weekEnd}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)
  const offset = new Intl.DateTimeFormat('en', { timeZone: 'America/New_York', timeZoneName: 'longOffset' }).formatToParts(new Date(`${next}T12:00:00Z`)).find(part => part.type === 'timeZoneName').value.replace('GMT', '')
  return Date.parse(`${next}T00:00:00${offset}`)
}

export function checkWaiverReset(state, week, resetsAt) {
  assert.equal(state.weekly_add_count, 0, 'The eligible week starts with a fresh add limit')
  assert.equal(state.week_number, week, 'Add limits use the expected calendar week')
  assert.equal(Date.parse(state.add_limit_resets_at), resetsAt, 'Add limits reset at Eastern midnight across DST')
}
