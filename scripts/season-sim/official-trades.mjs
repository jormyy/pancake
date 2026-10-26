import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql, sqlJson } from './local-stack.mjs'

async function offer(c, a, b, year, round) {
  const picks = await sqlJson(`SELECT json_agg(p ORDER BY current_owner_id) FROM draft_picks p WHERE league_id='${c.leagueId}' AND season_year=${year} AND round=${round} AND current_owner_id IN ('${a.memberId}','${b.memberId}') AND NOT is_used`, 'Official trade assets')
  const giving = picks.find(row => row.current_owner_id === a.memberId), receiving = picks.find(row => row.current_owner_id === b.memberId)
  assert.ok(giving && receiving)
  const body = { requestId: randomUUID(), leagueId: c.leagueId, leagueSeasonId: c.leagueSeasonId, memberId: a.memberId, recipientMemberId: b.memberId, offerPickIds: [giving.id], requestPickIds: [receiving.id] }
  const items = [{ fromMemberId: a.memberId, toMemberId: b.memberId, pickId: giving.id }, { fromMemberId: b.memberId, toMemberId: a.memberId, pickId: receiving.id }]
  const { quote } = await c.api(a, '/trades/estimate', { memberId: a.memberId, items })
  body.estimateId = quote.id
  const { tradeId } = await c.api(a, '/trades/propose', body)
  const result = { tradeId, body, giving, receiving, quoteReceipts: [] }
  await verifyQuote(c, result, b, 'received')
  return result
}


const orderedTerms = rows => rows.map(row => ({ fromMemberId: row.fromMemberId ?? row.from_member_id, toMemberId: row.toMemberId ?? row.to_member_id, playerId: row.playerId ?? row.player_id ?? null, pickId: row.pickId ?? row.pick_id ?? null, faabAmount: row.faabAmount ?? row.faab_amount ?? 0 })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

async function verifyQuote(c, trade, user, phase) {
  const stored = await sqlJson(`SELECT json_build_object('quote',(SELECT row_to_json(q) FROM trade_estimates e JOIN trade_estimate_quotes q ON q.id=e.quote_id WHERE e.trade_id='${trade.tradeId}'),'items',(SELECT json_agg(i) FROM trade_items i WHERE trade_id='${trade.tradeId}'))`, 'Retained trade quote')
  assert.ok(stored.quote, 'Every official offer retains its analysis and inputs')
  assert.equal(stored.quote.id, trade.body.estimateId)
  assert.deepEqual(orderedTerms(stored.quote.terms), orderedTerms(stored.items), 'Quoted terms equal the actual submitted trade items')
  if (trade.quote) assert.deepEqual(stored.quote, trade.quote, 'Analysis and input identity remain immutable across trade phases')
  else trade.quote = stored.quote
  const visible = await c.rest(user, `trade_estimate_quotes?select=*&id=eq.${stored.quote.id}`)
  assert.equal(visible.length, 1, 'The participant can read the saved quote')
  assert.deepEqual(visible[0].analysis, trade.quote.analysis)
  assert.deepEqual(visible[0].inputs, trade.quote.inputs)
  trade.quoteReceipts.push({ phase, quoteId: stored.quote.id, inputVersion: stored.quote.input_version, modelVersion: stored.quote.model_version })
}

async function assertOwners(trade, changed) {
  assert.equal(await sql(`SELECT current_owner_id FROM draft_picks WHERE id='${trade.giving.id}'`), changed ? trade.receiving.current_owner_id : trade.giving.current_owner_id)
  assert.equal(await sql(`SELECT current_owner_id FROM draft_picks WHERE id='${trade.receiving.id}'`), changed ? trade.giving.current_owner_id : trade.receiving.current_owner_id)
}

export async function advanceOfficialTrades(c, date, report, now) {
  const state = report.trades ??= {}
  if (date === '2024-11-01' && !state.completed) {
    state.completed = await offer(c, c.users[0], c.users[1], 2026, 1)
    await c.api(c.users[1], `/trades/${state.completed.tradeId}/accept`, { memberId: c.users[1].memberId })
    await verifyQuote(c, state.completed, c.users[0], 'accepted')
    state.completed.acceptedAt = now
    assert.equal(await sql(`SELECT status FROM trades WHERE id='${state.completed.tradeId}'`), 'accepted')
    await assertOwners(state.completed, false)
  }
  if (state.completed && !state.completed.checked && now >= state.completed.acceptedAt + 24 * 3600000 + 60000) {
    assert.equal(await sql(`SELECT status FROM trades WHERE id='${state.completed.tradeId}'`), 'completed')
    await assertOwners(state.completed, true)
    await verifyQuote(c, state.completed, c.users[1], 'executed')
    state.completed.checked = true
  }
  if (date === '2024-12-01' && !state.vetoed) {
    const trade = state.vetoed = await offer(c, c.users[2], c.users[3], 2027, 2)
    await c.api(c.users[3], `/trades/${trade.tradeId}/accept`, { memberId: c.users[3].memberId })
    await verifyQuote(c, trade, c.users[2], 'accepted')
    const voters = c.users.filter(user => ![c.users[0].memberId, c.users[2].memberId, c.users[3].memberId].includes(user.memberId)).slice(0, 4)
    for (const [index, user] of voters.entries()) {
      const result = await c.api(user, `/trades/${trade.tradeId}/veto`, { memberId: user.memberId })
      assert.equal(result.vetoed, index === 3, 'Four of eight eligible managers reach the official 50 percent threshold')
    }
    assert.equal(await sql(`SELECT status FROM trades WHERE id='${trade.tradeId}'`), 'vetoed')
    await assertOwners(trade, false)
    await verifyQuote(c, trade, c.users[3], 'vetoed')
    trade.checked = true
  }
  if (date === '2025-02-10' && !state.deadline) state.deadline = await offer(c, c.users[4], c.users[5], 2028, 3)
  if (date === '2025-02-12' && state.deadline && !state.deadline.checked) {
    const trade = state.deadline
    const rejected = await c.api(c.users[5], `/trades/${trade.tradeId}/accept`, { memberId: c.users[5].memberId }, 400)
    assert.match(JSON.stringify(rejected), /deadline|locked/i)
    const blocked = await c.api(c.users[4], '/trades/propose', { ...trade.body, requestId: randomUUID() }, 400)
    assert.match(JSON.stringify(blocked), /deadline|locked/i)
    await assertOwners(trade, false)
    await verifyQuote(c, trade, c.users[5], 'deadline-rejected')
    trade.checked = true
  }
}

export async function auditOfficialTradeValues(c, week, report) {
  report.tradeValueAudits ??= []
  if (report.tradeValueAudits.some(row => row.week === week)) return
  const [a, b] = c.users.slice(6, 8)
  const players = await sqlJson(`SELECT json_agg(r) FROM (SELECT DISTINCT ON(member_id) member_id,player_id FROM roster_players WHERE league_season_id='${c.leagueSeasonId}' AND member_id IN ('${a.memberId}','${b.memberId}') AND NOT is_on_ir AND NOT is_on_taxi ORDER BY member_id,player_id) r`, 'Held-out owned players')
  const picks = await sqlJson(`SELECT json_agg(p) FROM draft_picks p WHERE league_id='${c.leagueId}' AND season_year=${c.seasonYear + 1} AND current_owner_id IN ('${a.memberId}','${b.memberId}') AND NOT is_used`, 'Held-out owned picks')
  const route = (from, to, asset) => ({ fromMemberId: from.memberId, toMemberId: to.memberId, ...asset })
  const cases = [
    { kind: 'players', items: [route(a, b, { playerId: players.find(row => row.member_id === a.memberId).player_id }), route(b, a, { playerId: players.find(row => row.member_id === b.memberId).player_id })] },
    { kind: 'picks', items: [route(a, b, { pickId: picks.find(row => row.current_owner_id === a.memberId && row.round === 1).id }), route(b, a, { pickId: picks.find(row => row.current_owner_id === b.memberId && row.round === 3).id })] },
    { kind: 'faab', items: [route(a, b, { faabAmount: 10 }), route(b, a, { faabAmount: 50 })] },
  ]
  const receipts = []
  for (const scenario of cases) {
    const { quote } = await c.api(a, '/trades/estimate', { memberId: a.memberId, items: scenario.items })
    assert.deepEqual(orderedTerms(quote.terms), orderedTerms(scenario.items))
    for (const asset of quote.analysis.assets) {
      assert.ok(Number.isFinite(asset.values.overall) && asset.values.overall >= 0 && asset.values.overall <= 1000)
      if (asset.ranges.overall) assert.ok(asset.ranges.overall.low <= asset.values.overall && asset.values.overall <= asset.ranges.overall.high)
    }
    if (scenario.kind === 'picks') {
      const value = id => quote.analysis.assets.find(asset => asset.assetId === id).values.overall
      assert.ok(value(scenario.items[0].pickId) > value(scenario.items[1].pickId), 'A same-class first-round pick exceeds a third-round pick')
    }
    if (scenario.kind === 'faab') {
      const value = item => quote.analysis.assets.find(asset => asset.assetId === `faab:${item.fromMemberId}:${item.toMemberId}`).values.overall
      assert.ok(value(scenario.items[1]) > value(scenario.items[0]), 'More budget has greater value under the same league conditions')
    }
    const [frozenQuote] = await c.rest(a, `trade_estimate_quotes?select=*&id=eq.${quote.id}`)
    assert.ok(frozenQuote?.inputs, 'Held-out value audit retains its frozen source inputs')
    receipts.push({ ...scenario, quote, frozenQuote })
  }
  report.tradeValueAudits.push({ week, split: week === 17 ? 'final-held-out' : 'calibration-held-out', scope: 'Prespecified sensitivity and ordering checks; not independent market-price calibration', receipts })
}
