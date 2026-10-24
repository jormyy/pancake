import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, vi } from 'vitest'
import * as fixture from '../../scripts/ios-sim/seed.mjs'

test.each(['2026-10-23', undefined])('seed reuse rejects a stale or missing Eastern date: %s', async today => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ios-seed-date-'))
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-25T02:00:00Z'))
  try {
    await writeFile(path.join(directory, 'complete.json'), JSON.stringify({ today, rosterPlanTrade: { id: 'trade' } }))
    await assert.rejects(fixture.seed({ stack: { url: 'http://127.0.0.1:57121' }, snapshot: directory, directory }), /run start --reset/)
  } finally { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }) }
})

test('seed reuse uses the Eastern day across UTC midnight', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ios-seed-current-'))
  const complete = { today: '2026-10-24', rosterPlanTrade: { id: 'trade' } }
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-25T02:00:00Z'))
  try {
    await writeFile(path.join(directory, 'complete.json'), JSON.stringify(complete))
    assert.deepEqual(await fixture.seed({ stack: { url: 'http://127.0.0.1:57121' }, snapshot: directory, directory }), complete)
  } finally { vi.useRealTimers(); await rm(directory, { recursive: true, force: true }) }
})

function database() {
  const settings: Record<string, unknown> = {}
  const proposals: { name: string, args: Record<string, unknown> }[] = []
  let existing: { id: string } | null = null
  const client = {
    from(table: string) {
      const query = {
        update(value: object) { assert.equal(table, 'leagues'); Object.assign(settings, value); return query },
        select() { return query },
        eq() { return query },
        async maybeSingle() { return { data: existing, error: null } },
        then(resolve: (value: object) => void) { resolve({ data: null, error: null }) },
      }
      return query
    },
    async rpc(name: string, args: Record<string, unknown>) {
      proposals.push({ name, args })
      existing = { id: 'roster-plan-trade' }
      return { data: existing.id, error: null }
    },
  }
  return { client, settings, proposals }
}

test('the roster-plan fixture preserves rosters and creates an incoming overflow with a taxi rookie', async () => {
  const db = database()
  const members = Array.from({ length: 10 }, (_, index) => ({ id: `member-${index}` }))
  const players = Array.from({ length: 260 }, (_, index) => ({ id: `player-${index}`, years_exp: index % 22 === 21 ? 0 : 4, nba_draft_number: index % 22 === 21 ? 1 : null }))
  const input = { leagueId: 'league', seasonId: 'season', members, players }
  const before = JSON.stringify(input)
  const trade = await fixture.seedRosterPlanTrade(db.client, input)
  assert.equal(JSON.stringify(input), before)
  assert.equal(db.settings.allow_inactive_trades, true)
  assert.equal(db.proposals.length, 1)
  const proposal = db.proposals[0]
  assert.equal(proposal.name, 'propose_trade_atomic')
  assert.equal(proposal.args.p_recipient_member_id, members[trade.manager].id)
  const incoming = proposal.args.p_offer_player_ids as string[]
  const outgoing = proposal.args.p_request_player_ids as string[]
  const rookie = players.find(player => player.id === trade.rookiePlayerId)!
  assert.equal(rookie.years_exp, 0)
  assert.ok(rookie.nba_draft_number)
  assert.ok(incoming.includes(rookie.id))
  const incomingActive = incoming.filter(id => id !== rookie.id).length
  assert.equal(20 + incomingActive - outgoing.length, 21)
  assert.equal(20 + incomingActive - outgoing.length - 1, 20)
  assert.ok(![...incoming, ...outgoing].includes(trade.dropPlayerId))
  assert.equal(trade.dropPlayerId, players[trade.manager * 22 + 18].id)
  assert.equal((await fixture.seedRosterPlanTrade(db.client, input)).id, trade.id)
  assert.equal(db.proposals.length, 1)
})

test('an auction capture removes its nomination when the check fails', async () => {
  const nominations: any[] = [{ id: 'closed', status: 'won', nomination_order: 2 }]
  const before = JSON.stringify(nominations)
  const admin = {
    from(table: string) {
      assert.equal(table, 'nominations')
      let inserting: any, removing = false
      const query = {
        select() { return query },
        eq(_key: string, value: string) {
          if (removing) nominations.splice(nominations.findIndex(row => row.id === value), 1)
          return query
        },
        insert(row: object) { inserting = { ...row, id: 'capture', status: 'open' }; return query },
        delete() { removing = true; return query },
        async single() { nominations.push(inserting); return { data: inserting, error: null } },
        then(resolve: (value: object) => void) { resolve({ data: [...nominations], error: null }) },
      }
      return query
    },
  }
  await assert.rejects(fixture.withAuctionNomination(admin, { draftId: 'auction', memberId: 'leader', playerId: 'free-agent' }, async () => {
    const open = nominations.find(row => row.status === 'open')!
    assert.equal(open.draft_id, 'auction')
    assert.equal(open.player_id, 'free-agent')
    assert.equal(open.current_bidder_id, 'leader')
    assert.equal(open.nomination_order, 3)
    assert.ok(Date.parse(open.countdown_expires_at) > Date.now() + 3500000)
    throw new Error('Missing bid control')
  }), /Missing bid control/)
  assert.equal(JSON.stringify(nominations), before)
})

test.each([false, true])('an IR capture restores injuries after success or failure: %s', async fail => {
  const players = [{ id: 'ir-player', injury_status: 'Out' as string | null }, { id: 'other-player', injury_status: 'Doubtful' as string | null }]
  const before = JSON.stringify(players)
  const admin = {
    from(table: string) {
      const filters = new Map<string, unknown>()
      let update: { injury_status: string | null } | undefined
      const query = {
        select() { return query },
        eq(key: string, value: unknown) { filters.set(key, value); return query },
        in(key: string, value: unknown[]) { filters.set(key, value); return query },
        update(value: { injury_status: string | null }) { update = value; return query },
        then(resolve: (value: object) => void) {
          if (table === 'roster_players') {
            assert.equal(filters.get('member_id'), 'manager')
            assert.equal(filters.get('league_season_id'), 'season')
            assert.equal(filters.get('is_on_ir'), true)
            resolve({ data: [{ player_id: 'ir-player' }], error: null })
          } else {
            assert.equal(table, 'players')
            const ids = filters.get('id')
            const matching = players.filter(player => Array.isArray(ids) ? ids.includes(player.id) : player.id === ids)
            const data = matching.map(player => ({ ...player }))
            if (update) for (const player of matching) Object.assign(player, update)
            resolve({ data, error: null })
          }
        },
      }
      return query
    },
  }
  const capture = () => fixture.withHealthyIRPlayer(admin, { memberId: 'manager', seasonId: 'season' }, async () => {
    assert.equal(players[0].injury_status, null)
    assert.equal(players[1].injury_status, 'Doubtful')
    if (fail) throw new Error('Capture failed')
    return 'captured'
  })
  if (fail) await assert.rejects(capture(), /Capture failed/)
  else assert.equal(await capture(), 'captured')
  assert.equal(JSON.stringify(players), before)
})

test.each(['auction', 'snake'])('a %s room capture builds its own draft and removes it after failure', async draftType => {
  const tables = new Map<string, any[]>()
  const deleted: string[] = []
  const admin = {
    from(table: string) {
      let row: any, removing = false
      const query = {
        insert(value: any) { row = value; return query },
        delete() { removing = true; return query },
        eq(key: string, value: string) {
          assert.equal(table, 'drafts'); assert.equal(key, 'id'); assert.equal(value, 'capture')
          deleted.push(value)
          return query
        },
        then(resolve: (value: object) => void) {
          if (!removing) tables.set(table, Array.isArray(row) ? row : [row])
          resolve({ data: null, error: null })
        },
      }
      return query
    },
  }
  const members = Array.from({ length: 10 }, (_, index) => ({ id: `member-${index}` }))
  await assert.rejects(fixture.withDraftRoom(admin, { draftId: 'capture', draftType, leagueId: 'league', seasonId: 'season', members }, async () => {
    const draft = tables.get('drafts')![0]
    assert.equal(draft.league_id, 'league')
    assert.equal(draft.league_season_id, 'season')
    assert.equal(draft.draft_type, draftType)
    assert.equal(draft.status, 'in_progress')
    assert.equal(draft.is_mock, true)
    assert.deepEqual(tables.get('draft_room_members')!.map(row => row.member_id), members.map(member => member.id))
    assert.equal(tables.get('draft_orders')!.length, 10)
    if (draftType === 'auction') {
      assert.equal(tables.get('draft_budgets')!.length, 10)
      assert.ok(tables.get('draft_budgets')!.every(row => row.remaining === 200 && row.draft_id === 'capture'))
    } else {
      const picks = tables.get('snake_draft_picks')!
      assert.equal(picks.length, 30)
      assert.deepEqual(picks.filter(row => row.round === 2).map(row => row.member_id), [...members].reverse().map(member => member.id))
      assert.ok(picks.every((row, index) => row.overall_pick === index + 1 && row.draft_id === 'capture'))
    }
    throw new Error('Capture failed')
  }), /Capture failed/)
  assert.deepEqual(deleted, ['capture'])
})

function captureDatabase(initial: Record<string, any[]>) {
  const tables = structuredClone(initial)
  let sequence = 0
  const admin = {
    from(table: string) {
      const filters: ((row: any) => boolean)[] = []
      let update: object | null = null, insert: any[] | null = null, removing = false
      const result = () => {
        tables[table] ??= []
        if (insert) tables[table].push(...insert.map(row => ({ id: `capture-${++sequence}`, ...row })))
        const rows = tables[table].filter(row => filters.every(filter => filter(row)))
        if (update) for (const row of rows) Object.assign(row, update)
        if (removing) {
          tables[table] = tables[table].filter(row => !rows.includes(row))
          if (table === 'leagues') for (const child of ['league_members', 'league_seasons']) {
            tables[child] = (tables[child] ?? []).filter(row => !rows.some(league => league.id === row.league_id))
          }
        }
        return structuredClone(rows)
      }
      const query = {
        select() { return query },
        eq(key: string, value: unknown) { filters.push(row => row[key] === value); return query },
        is(key: string, value: unknown) { return query.eq(key, value) },
        lte(key: string, value: any) { filters.push(row => row[key] <= value); return query },
        gte(key: string, value: any) { filters.push(row => row[key] >= value); return query },
        update(value: object) { update = value; return query },
        insert(value: any) { insert = Array.isArray(value) ? value : [value]; return query },
        delete() { removing = true; return query },
        single: async () => ({ data: result()[0], error: null }),
        maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
        then(resolve: (value: object) => void) { resolve({ data: result(), error: null }) },
      }
      return query
    },
  }
  return { admin, tables }
}

test.each([false, true])('IR claim setup creates its own Out waiver and restores after capture failure: %s', async fail => {
  const { admin, tables } = captureDatabase({ players: [{ id: 'target', injury_status: null }], waiver_wire_log: [] })
  const capture = () => fixture.withWaiverIRPlayer(admin, { leagueId: 'league', seasonId: 'season', playerId: 'target' }, async () => {
    assert.equal(tables.players[0].injury_status, 'Out')
    assert.equal(tables.waiver_wire_log.length, 1)
    assert.equal(tables.waiver_wire_log[0].player_id, 'target')
    assert.equal(tables.waiver_wire_log[0].league_season_id, 'season')
    assert.ok(Date.parse(tables.waiver_wire_log[0].clears_at) > Date.now())
    if (fail) throw new Error('Capture failed')
    return 'captured'
  })
  if (fail) await assert.rejects(capture(), /Capture failed/)
  else assert.equal(await capture(), 'captured')
  assert.equal(tables.players[0].injury_status, null)
  assert.equal(tables.waiver_wire_log.length, 0)
})

test('IR shortcut setup restores the selected active player without changing another injury', async () => {
  const { admin, tables } = captureDatabase({ players: [{ id: 'active', injury_status: 'Doubtful' }, { id: 'other', injury_status: null }] })
  await assert.rejects(fixture.withOutPlayer(admin, 'active', async () => {
    assert.equal(tables.players[0].injury_status, 'Out')
    assert.equal(tables.players[1].injury_status, null)
    throw new Error('Capture failed')
  }), /Capture failed/)
  assert.equal(tables.players[0].injury_status, 'Doubtful')
})

test.each([false, true])('week-off setup owns its skipped-week league and removes it after failure: %s', async fail => {
  const { admin, tables } = captureDatabase({
    leagues: [{ id: 'original', name: 'Original' }],
    league_members: [{ id: 'member', league_id: 'original', user_id: 'user', team_name: 'Manager' }],
    league_seasons: [], season_weeks: [{ season_year: 2027, week_number: 3, week_start: '2026-10-19', week_end: '2026-10-25' }],
  })
  const before = structuredClone(tables)
  const capture = () => fixture.withWeekOffLeague(admin, { memberId: 'member', seasonYear: 2027, today: '2026-10-24', name: 'Week off fixture' }, async () => {
    const league = tables.leagues.find(row => row.id !== 'original')!
    assert.equal(league.name, 'Week off fixture')
    assert.equal(league.status, 'active')
    assert.equal(tables.league_members.find(row => row.league_id === league.id)?.user_id, 'user')
    assert.deepEqual(tables.league_seasons.find(row => row.league_id === league.id)?.skipped_weeks, [3])
    if (fail) throw new Error('Capture failed')
    return 'captured'
  })
  if (fail) await assert.rejects(capture(), /Capture failed/)
  else assert.equal(await capture(), 'captured')
  assert.deepEqual(tables, before)
})
