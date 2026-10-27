import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { openWebTarget, WEB_TARGETS, navigateWebTarget, waitForWebTargetReads } from './web-targets-browser.mjs'
import { stackEnvironment, requireSweepStack } from './layout-stability-ports.mjs'
import { createDisposableLeagueFromSeedUsers, currentSeasonYear } from './soak-fixtures.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)))
const env = await stackEnvironment(args.env)
requireSweepStack(env)
const state = JSON.parse(await readFile(args.state, 'utf8'))
const checked = async operation => { const { data, error } = await operation; assert.ifError(error); return data }
const admin = createClient(env.E2E_SUPABASE_URL, env.E2E_PANCAKE_SUPABASE_SECRET_KEY, { auth: { persistSession: false }, global: { fetch: (input, init) => { const headers = new Headers(init?.headers); headers.set('x-request-id', randomUUID()); headers.set('x-request-actor', state.users[0].id); return fetch(input, { ...init, headers }) } } })
const sessions = await Promise.all(state.users.slice(0, 2).map(async user => {
    const auth = createClient(env.E2E_SUPABASE_URL, env.E2E_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } })
    return (await checked(auth.auth.signInWithPassword({ email: user.email, password: state.password }))).session
}))
await mkdir(args.output, { recursive: true })
await runWithScenarioResourceOwner('screen write freshness', async resourceOwner => {
    const { league, leagueSeason, members } = await createDisposableLeagueFromSeedUsers({ supabase: admin, state, season: 0, seasonYear: currentSeasonYear(), label: 'screen freshness', userCount: 2, resourceOwner })
    await checked(admin.from('leagues').update({ trade_veto_mode: 'member_vote', trade_veto_window_hours: 24 }).eq('id', league.id))
    const players = await checked(admin.from('players').select('id,display_name').in('sportsdata_id', ['e2e-player-001', 'e2e-player-011', 'e2e-player-026']).order('sportsdata_id'))
    await checked(admin.from('roster_players').insert(members.map((member, index) => ({ league_id: league.id, league_season_id: leagueSeason.id, member_id: member.id, player_id: players[index].id, acquired_via: 'e2e_screen_freshness' }))))
    await checked(admin.from('waiver_priorities').upsert(members.map((member, index) => ({ league_id: league.id, league_season_id: leagueSeason.id, member_id: member.id, priority: index + 1 })), { onConflict: 'league_id,league_season_id,member_id' }))
    await checked(admin.from('faab_balances').upsert(members.map(member => ({ league_id: league.id, league_season_id: leagueSeason.id, member_id: member.id, balance: 100 })), { onConflict: 'league_id,league_season_id,member_id' }))
    const tradeId = await checked(admin.rpc('propose_trade_atomic', { p_league_id: league.id, p_league_season_id: leagueSeason.id, p_proposer_member_id: members[0].id, p_recipient_member_id: members[1].id, p_offer_player_ids: [players[0].id], p_request_player_ids: [players[1].id], p_offer_pick_ids: [], p_request_pick_ids: [] }))
    const post = async (path, body, index = 0) => {
        const response = await fetch(`${env.E2E_API_BASE_URL}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${sessions[index].access_token}`, 'Content-Type': 'application/json', 'x-request-id': randomUUID() }, body: JSON.stringify(body) })
        const value = await response.json()
        assert.equal(response.ok, true, JSON.stringify(value))
        return value
    }
    const version = async () => {
        const response = await fetch(`${env.E2E_API_BASE_URL}/version?league=${league.id}&since=0`, { headers: { Authorization: `Bearer ${sessions[0].access_token}` } })
        assert.equal(response.ok, true)
        return BigInt((await response.json()).version)
    }
    const target = WEB_TARGETS.find(row => row.engine === 'webkit' && row.viewport.width === 390 && !row.standalone)
    const storedSession = [{ name: `sb-${new URL(env.E2E_SUPABASE_URL).hostname.split('.')[0]}-auth-token`, value: JSON.stringify(sessions[0]) }, { name: `pancake:selected-league:v1:${sessions[0].user.id}`, value: JSON.stringify({ version: 1, savedAt: Date.now(), value: members[0].id }) }]
    const client = await openWebTarget(target, args.output, { storageState: { cookies: [], origins: [{ origin: env.E2E_FRONTEND_URL, localStorage: storedSession }] } })
    try {
        await client.context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
        await navigateWebTarget(client.page, new URL('/trades?tab=history', env.E2E_FRONTEND_URL).href)
        await client.page.getByText('No completed trades yet.', { exact: true }).waitFor()
        await waitForWebTargetReads(client.page)
        const beforeTrade = await version()
        await post(`/trades/${tradeId}/accept`, { memberId: members[1].id }, 1)
        await client.page.getByText('Accepted', { exact: true }).waitFor({ timeout: 20000 })
        const afterTrade = await version()
        assert.equal(afterTrade - beforeTrade, 1n)
        await navigateWebTarget(client.page, new URL('/roster', env.E2E_FRONTEND_URL).href)
        await client.page.getByText(players[0].display_name, { exact: true }).waitFor()
        await post('/waivers/claims', { memberId: members[0].id, leagueId: league.id, playerId: players[2].id, bidAmount: 0 })
        await client.page.getByText('1 claim pending', { exact: true }).waitFor({ timeout: 20000 })
        const claim = await checked(admin.from('waiver_claims').select('id').eq('league_id', league.id).eq('player_id', players[2].id).single())
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
        await checked(admin.from('waiver_claims').update({ process_date: yesterday }).eq('id', claim.id))
        await waitForWebTargetReads(client.page)
        const beforeAward = await version()
        const awards = await checked(admin.rpc('process_due_waiver_claims_atomic', { p_process_date: yesterday, p_limit: 1 }))
        assert.ok(awards.some(row => row.claim_id === claim.id && row.status === 'succeeded'))
        await client.page.getByText('1 claim pending', { exact: true }).waitFor({ state: 'hidden', timeout: 20000 })
        await client.page.getByText(players[2].display_name, { exact: true }).first().waitFor({ timeout: 20000 })
        const afterAward = await version()
        assert.equal(afterAward - beforeAward, 1n)
        const rows = await checked(admin.from('roster_players').select('id').eq('league_id', league.id).eq('member_id', members[0].id).eq('player_id', players[2].id))
        assert.equal(rows.length, 1)
        await writeFile(`${args.output}/report.json`, JSON.stringify({ acceptedTradeVisible: true, awardedWaiverVisible: true, tradeVersionBumps: Number(afterTrade - beforeTrade), awardVersionBumps: Number(afterAward - beforeAward) }, null, 2))
    } catch (error) {
        await writeFile(`${args.output}/failure.txt`, await client.page.locator('body').innerText())
        await client.page.screenshot({ path: `${args.output}/failure.png`, fullPage: true })
        throw error
    } finally { await client.context.close(); await client.browser.close() }
})
