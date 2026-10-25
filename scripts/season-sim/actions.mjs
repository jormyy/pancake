import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { season, config, originUrl, assertTarget, miniRoot, writeJson } from './common.mjs'
import { setClock } from './clock.mjs'
import { sql } from './local-stack.mjs'
import {plannedAuctionBid} from './auction-plan.mjs'
import { ensureRegularSchedule } from './schedule.mjs'

/** @typedef {{ id: string, token: string, refreshToken: string, expiresAt: number, memberId?: string }} ReplayUser */

export function actionClient(keys) {
  assertTarget(keys.API_URL, 'api')
  const tokenListeners = new Set()
  /**
   * @param {unknown} [body]
   * @param {number | number[]} [expected]
   * @param {string} [method]
   */
  async function request(origin, route, token, body, expected = 200, method) {
    assertTarget(origin, new URL(origin).port === String(config.ports.edge) ? 'edge' : 'api')
    const response = await fetch(`${origin}${route}`, { method: method ?? (body ? 'POST' : 'GET'), headers: { apikey: keys.ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' }, body: body ? JSON.stringify(body) : undefined, redirect: 'error' })
    const text = await response.text()
    const data = text ? JSON.parse(text) : null
    await appendFile(path.join(miniRoot, 'evidence/user-actions.jsonl'), `${JSON.stringify({ provenance: 'SYNTHETIC', route, status: response.status, expected, realAt: new Date().toISOString() })}\n`)
    assert.ok(Array.isArray(expected) ? expected.includes(response.status) : expected === 200 ? response.ok : response.status === expected, `${route}: HTTP ${response.status} ${JSON.stringify(data)}`)
    return data
  }
  const refresh = async user => {
    if (!user.refreshToken || Date.now() < user.expiresAt - 60000) return user.token
    const response = await fetch(`${keys.API_URL}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: keys.ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: user.refreshToken }), redirect: 'error' })
    assert.ok(response.ok, `Local session refresh: ${response.status}`)
    const session = await response.json()
    Object.assign(user, { token: session.access_token, refreshToken: session.refresh_token, expiresAt: Date.now() + session.expires_in * 1000 })
    await Promise.all([...tokenListeners].map(listener => listener(user)))
    return user.token
  }
  /** @param {number | number[]} [expected] */
  const rpc = async (user, name, body, expected = 200) => request(keys.API_URL, `/rest/v1/rpc/${name}`, await refresh(user), body, expected)
  /** @param {number | number[]} [expected] */
  const api = async (user, route, body, expected = 200) => request(originUrl('edge'), `/functions/v1/api${route}`, await refresh(user), body, expected)
  const rest = async (user, query) => request(keys.API_URL, `/rest/v1/${query}`, await refresh(user))
  const restWrite = async (user, query, body, method = 'POST') => request(keys.API_URL, `/rest/v1/${query}`, await refresh(user), body, 200, method)
  const onTokenRefresh = listener => {
    tokenListeners.add(listener)
    return () => tokenListeners.delete(listener)
  }
  return { rpc, api, rest, restWrite, onTokenRefresh }
}

export async function createLeagueActions(keys, date, teamCount = 2, options = {}) {
  assertTarget(keys.API_URL, 'api')
  const run = randomBytes(6).toString('hex')
  /** @type {ReplayUser[]} */
  const users = []
  const { rpc, api, rest, restWrite, onTokenRefresh } = actionClient(keys)
  for (let index = 0; index < teamCount; index++) {
    const email = `season-sim-${run}-${index}@example.test`, password = randomBytes(24).toString('hex')
    const created = await fetch(`${keys.API_URL}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: keys.SERVICE_ROLE_KEY, Authorization: `Bearer ${keys.SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, email_confirm: true }), redirect: 'error' })
    assert.ok(created.ok, `Local auth create: ${created.status}`)
    const login = await fetch(`${keys.API_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: keys.ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }), redirect: 'error' })
    assert.ok(login.ok, `Local auth login: ${login.status}`)
    const session = await login.json()
    users.push({ id: session.user.id, token: session.access_token, refreshToken: session.refresh_token, expiresAt: Date.now() + session.expires_in * 1000 })
  }
  const league = await rpc(users[0], 'create_league', { p_name: `Historical replay ${run}`, p_team_name: 'Synthetic home', p_auction_budget: 20 })
  for (const [index, user] of users.slice(1).entries()) await rpc(user, 'join_league_by_invite_code', { p_invite_code: league.invite_code, p_team_name: `Synthetic away ${index + 1}` })
  const leagueId = league.id
  const skipped = options.skipPastWeeks ? JSON.parse(await sql(`SELECT coalesce(json_agg(week_number ORDER BY week_number),'[]') FROM season_weeks WHERE season_year=${season.year} AND week_end<'${date}'`)) : null
  await rpc(users[0], 'update_league_configuration_atomic', { p_league_id: leagueId, p_settings: { ...(skipped ? { skipped_weeks: skipped } : {}), ...(options.integrated ? { waiver_mode: 'faab', faab_starting_budget: 100, weekly_add_limit: 1 } : {}), roster_size: 3, ir_slots: 2, taxi_slots: options.integrated ? 4 : 0, playoff_entrants: options.integrated ? 4 : 2, playoff_start_week: options.playoffStartWeek ?? (options.integrated ? 23 : 20), playoff_round_lengths: options.roundLengths ?? (options.integrated ? [1, 2] : [1]) }, p_slots: [...['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'].map(slot_type => ({ slot_type, slot_count: 0 })), { slot_type: 'UTIL', slot_count: 2 }, { slot_type: 'BE', slot_count: 1 }] })
  const configuredSlots = await rest(users[0], `lineup_slot_templates?select=slot_type,slot_count&league_id=eq.${leagueId}`)
  for (const row of configuredSlots) assert.equal(row.slot_count, row.slot_type === 'UTIL' ? 2 : row.slot_type === 'BE' ? 1 : row.slot_type === 'IR' ? 2 : 0, 'Commissioner slot configuration must match the declared scenario')
  const members = JSON.parse(await sql(`SELECT json_agg(t) FROM (SELECT id,user_id FROM league_members WHERE league_id='${leagueId}') t`))
  const leagueSeasonId = await sql(`SELECT id FROM league_seasons WHERE league_id='${leagueId}' AND is_current`)
  for (const user of users) user.memberId = members.find(member => member.user_id === user.id).id
  const { draft } = await api(users[0], '/draft/start', { leagueId, timerSeconds: 5 })
  let clock = Date.parse(`${options.auctionDate ?? date}T14:00:00Z`)
  await (options.move ? options.move(clock) : setClock({ at: new Date(clock).toISOString(), rate: 0 }))
  const players = JSON.parse(await sql(`SELECT json_agg(t) FROM (SELECT p.id,p.nba_id FROM players p WHERE p.nba_team IN (SELECT home_team FROM nba_games WHERE game_date='${date}' UNION SELECT away_team FROM nba_games WHERE game_date='${date}') AND p.injury_status IS NULL AND p.position IS NOT NULL ORDER BY p.nba_id LIMIT ${teamCount * 3}) t`))
  if (options.integrated) {
    const memberId = await sql(`SELECT member_id FROM draft_orders WHERE draft_id='${draft.id}' AND position=1`)
    const user = users.find(user => user.memberId === memberId)
    const unused = await sql(`SELECT id FROM players WHERE nba_id IS NOT NULL AND id NOT IN (${players.map(player => `'${player.id}'`).join(',')}) ORDER BY nba_id DESC LIMIT 1`)
    const { nomination } = await api(user, `/draft/${draft.id}/nominate`, { memberId, playerId: unused })
    assert.equal((await api(user, `/draft/${draft.id}/withdraw-nomination`, { memberId, nominationId: nomination.id })).withdrawn, true)
  }
  const purchases=new Map()
  for (let index = 0; index < teamCount * 3; index++) {
    const memberId = await sql(`SELECT member_id FROM draft_orders WHERE draft_id='${draft.id}' AND position=(SELECT ((current_nomination_order-1)%${teamCount})+1 FROM drafts WHERE id='${draft.id}')`)
    const user = users.find(user => user.memberId === memberId)
    const { nomination } = await api(user, `/draft/${draft.id}/nominate`, { memberId, playerId: players[index].id })
    if (index === 0) await api(user, `/draft/${draft.id}/bid`, { memberId, nominationId: nomination.id, amount: 21 }, 400)
    const purchased=purchases.get(memberId)??0
    await api(user, `/draft/${draft.id}/bid`, { memberId, nominationId: nomination.id, amount: plannedAuctionBid(purchased) })
    clock += 16000
    await (options.move ? options.move(clock) : setClock({ at: new Date(clock).toISOString(), rate: 0 }))
    await api(user, `/draft/${draft.id}/close-expired`, {})
    purchases.set(memberId,purchased+1)
  }
  assert.equal(await sql(`SELECT status FROM drafts WHERE id='${draft.id}'`), 'completed')
  await ensureRegularSchedule({ api, rest, users, leagueId, leagueSeasonId })
  for (const user of users) await api(user, '/league/lineup/auto-set-season', { memberId: user.memberId, leagueId, leagueSeasonId, dates: [date] })
  const context = { leagueId, leagueSeasonId, seasonYear: season.year, seasonEnd:season.end, firstDate: date, diagnosticSkippedWeeks: skipped, draftId: draft.id, members, date }
  await writeJson(path.join(miniRoot, 'state/league.json'), context)
  return { ...context, users, rpc, api, rest, restWrite, onTokenRefresh }
}
