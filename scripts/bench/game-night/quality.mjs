import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { delay, id, loopback, quote } from './common.mjs'

export function userToken(stack, userId) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'HS256', typ: 'JWT' })
  const payload = encode({ sub: userId, aud: 'authenticated', role: 'authenticated', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7200 })
  assert.ok(stack.keys.JWT_SECRET, 'Local JWT signing key is missing')
  return `${header}.${payload}.${createHmac('sha256', stack.keys.JWT_SECRET).update(`${header}.${payload}`).digest('base64url')}`
}

export async function prepareActions(stack) {
  await stack.sql(`UPDATE auth.users SET instance_id='00000000-0000-0000-0000-000000000000',
    confirmation_token='',recovery_token='',email_change_token_new='',email_change='',email_change_token_current='',reauthentication_token=''
    WHERE id IN(game_night.id(109),game_night.id(110));
    BEGIN; SET LOCAL session_replication_role=replica;
    UPDATE public.roster_players SET player_id=game_night.id(CASE player_id
      WHEN game_night.id(1199) THEN 1501 WHEN game_night.id(1200) THEN 1502
      WHEN game_night.id(1179) THEN 1503 ELSE 1504 END)
    WHERE player_id IN(game_night.id(1199),game_night.id(1200),game_night.id(1179),game_night.id(1180)); COMMIT;
    INSERT INTO public.waiver_priorities(league_id,league_season_id,member_id,priority)
      SELECT game_night.id(1),game_night.id(2),game_night.id(200+n),n FROM generate_series(1,10)n ON CONFLICT DO NOTHING;
    INSERT INTO public.faab_balances(league_id,league_season_id,member_id,balance)
      SELECT game_night.id(1),game_night.id(2),game_night.id(200+n),100 FROM generate_series(1,10)n ON CONFLICT DO NOTHING;
    INSERT INTO public.waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at,clears_at)
      VALUES(game_night.id(1),game_night.id(2),game_night.id(1506),now()-interval '3 days',now()-interval '2 days');`)
  stack.realtimeToken = userToken(stack, id(109))
}

export function startActions(stack, started, { limits = {}, fault } = {}) {
  const records = []
  const faults = new Set(fault?.split(',') ?? [])
  let tradeId
  const tokens = new Map([9,10].map(member => [member, userToken(stack, id(100 + member))]))
  const send = async (member, route, body, api = false) => {
    const base = api ? `http://127.0.0.1:${stack.ports.edge}/functions/v1/api` : `${stack.api}/rest/v1/rpc`
    const target = loopback(`${base}/${route}`, [stack.ports.api,stack.ports.edge])
    const response = await fetch(target, { method: 'POST', headers: { apikey: stack.keys.ANON_KEY, authorization: `Bearer ${tokens.get(member)}`, 'content-type': 'application/json', 'x-request-id': randomUUID() }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
    const text = await response.text()
    assert.ok(response.ok, `${route} failed (${response.status}): ${text.slice(0,600)}`)
    return text ? JSON.parse(text) : null
  }
  const schedule = async (offset, name, run) => {
    await delay(Math.max(0, started + offset * 1000 - Date.now()))
    const begin = Date.now()
    const record = { name, started: begin, passed: false, latencyMs: null, limitMs: limits[name] ?? null }
    records.push(record)
    try {
      if (faults.has(name) || faults.has('slow-actions')) await delay((limits[name] ?? 1000) + 1000)
      await run()
      record.latencyMs = Date.now() - begin
      record.passed = record.limitMs == null || record.latencyMs <= record.limitMs
      if (!record.passed) record.error = 'Latency exceeds the frozen baseline limit'
    } catch (error) { record.latencyMs = Date.now() - begin; record.error = error.message }
    await appendFile(path.join(stack.evidence, 'action-events.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 })
  }
  const notifications = async (member, category, at) => Number(await stack.sql(`SELECT count(*) FROM public.notification_outbox WHERE member_id=${quote(id(200+member))} AND category=${quote(category)} AND created_at>=${quote(new Date(at).toISOString())}`))
  const tasks = [
    schedule(15, 'rosterMove', async () => {
      const rosterId = await stack.sql(`SELECT id FROM public.roster_players WHERE league_id='${id(1)}' AND member_id='${id(210)}' AND player_id='${id(1502)}'`)
      assert.ok(rosterId)
      await send(10, 'drop_player_atomic', { p_roster_player_id: rosterId, p_expected_league_season_id: id(2) })
      assert.equal(await stack.sql(`SELECT count(*) FROM public.roster_players WHERE member_id='${id(210)}' AND player_id='${id(1502)}'`), '0')
    }),
    schedule(45, 'lineupSave', async () => {
      const date = JSON.parse(await stack.sql("SELECT json_build_object('day',(now() AT TIME ZONE 'America/New_York')::date+1,'week',(SELECT week_number FROM public.season_weeks WHERE season_year=public.current_season_year_et() AND (now() AT TIME ZONE 'America/New_York')::date+1 BETWEEN week_start AND week_end LIMIT 1))"))
      await send(10, 'set_player_slot_moves_atomic', { p_member_id: id(210), p_league_id: id(1), p_league_season_id: id(2), p_game_date: date.day, p_week_number: date.week, p_moves: [{ player_id: id(1501), slot_type: 'UTIL' }] })
      assert.equal(await stack.sql(`SELECT slot_type FROM public.weekly_lineups WHERE member_id='${id(210)}' AND player_id='${id(1501)}' AND game_date=${quote(date.day)}`), 'UTIL')
    }),
    schedule(75, 'tradeOffer', async () => {
      const at = Date.now()
      const result = await send(10, 'trades/propose', { requestId: randomUUID(), memberId: id(210), leagueId: id(1), leagueSeasonId: id(2), recipientMemberId: id(209), offerPlayerIds: [id(1501)], requestPlayerIds: [id(1503)], offerPickIds: [], requestPickIds: [] }, true)
      tradeId = result.tradeId
      assert.ok(tradeId)
      assert.equal(await stack.sql(`SELECT status FROM public.trades WHERE id=${quote(tradeId)}`), 'pending')
      assert.ok(await notifications(9, 'trade', at), 'Trade-offer notification is missing')
    }),
    schedule(90, 'tradeAccept', async () => {
      assert.ok(tradeId, 'The preceding offer did not finish')
      const at = Date.now()
      await send(9, `trades/${tradeId}/accept`, { memberId: id(209) }, true)
      const state = await stack.sql(`SELECT status FROM public.trades WHERE id=${quote(tradeId)}`)
      assert.ok(['accepted','completed'].includes(state), `Unexpected accepted trade state: ${state}`)
      assert.ok(await notifications(10, 'trade', at), 'Trade-acceptance notification is missing')
    }),
    schedule(105, 'waiverResult', async () => {
      const claim = await stack.sql(`INSERT INTO public.waiver_claims(league_id,league_season_id,member_id,player_id,drop_player_id,priority_at_submission,process_date,bid_amount,claim_order)
        SELECT league_id,league_season_id,member_id,'${id(1506)}','${id(1504)}',priority,(now() AT TIME ZONE 'America/Los_Angeles')::date,1,1
        FROM public.waiver_priorities WHERE member_id='${id(209)}' RETURNING id`)
      assert.ok(claim, 'Waiver claim is missing')
      const at = Date.now()
      await stack.sql(`SELECT private.work_enqueue('process-waivers',${quote('game-night:'+randomUUID())},now(),jsonb_build_object('timezone','America/Los_Angeles','date',(now() AT TIME ZONE 'America/Los_Angeles')::date));`)
      let state = ''
      while (Date.now() - at < 110000) {
        state = await stack.sql(`SELECT status FROM public.waiver_claims WHERE id=${quote(claim)}`)
        if (state !== 'pending') break
        await delay(500)
      }
      assert.equal(state, 'succeeded')
      assert.equal(await stack.sql(`SELECT count(*) FROM public.roster_players WHERE member_id='${id(209)}' AND player_id='${id(1506)}'`), '1')
      assert.ok(await notifications(9, 'waiver', at), 'Waiver notification is missing')
    }),
  ]
  return { records, done: Promise.all(tasks).then(() => ({ passed: records.length === 5 && records.every(record => record.passed), records })) }
}
