import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setupTradeGameplayFixture, findAvailablePlayers } from './trade-fixture.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { stackEnvironment, requireSweepStack, resolveSweepPorts } from './layout-stability-ports.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)))
const env = await stackEnvironment(args.env)
requireSweepStack(env, resolveSweepPorts({}, env))
const originalFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).origin, new URL(env.E2E_SUPABASE_URL).origin)
    const headers = new Headers(request.headers)
    headers.set('x-request-id', randomUUID())
    return originalFetch(new Request(request, { headers }))
}
const run = (command, values, options = {}) => new Promise((resolve, reject) => {
    const child = spawn(command, values, { stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exits ${code}`)))
})
const checked = async query => {
    const { data, error } = await query
    assert.ifError(error)
    return data
}
await mkdir(args.output, { recursive: true })
await runWithScenarioResourceOwner('Round 2 UX', async () => {
    const fixture = await setupTradeGameplayFixture({ supabaseUrl: env.E2E_SUPABASE_URL,
        serviceRoleKey: env.E2E_PANCAKE_SUPABASE_SECRET_KEY, anonKey: env.E2E_SUPABASE_PUBLISHABLE_KEY }, 0, { includeFuturePicks: false, isolatedPlayers: true })
    await checked(fixture.admin.from('league_members').update({ team_name: "Mike's Minions" }).eq('id', fixture.proposer.id))
    await checked(fixture.admin.from('league_members').update({ team_name: 'Matthew' }).eq('id', fixture.recipient.id))
    const created = await findAvailablePlayers(fixture.admin, fixture.league.id, fixture.currentSeason.id, 3, fixture.registerCreatedPlayer, { createOnly: true })
    const extra = created.slice(0, 2)
    const freePlayer = created[2]
    await checked(fixture.admin.from('players').update({ birthdate: '1996-10-28', years_exp: 8, nba_team: 'BOS' })
        .in('id', [fixture.proposerPlayer.id, fixture.recipientPlayer.id, ...created.map(player => player.id)]))
    const roster = [fixture.proposerPlayer, fixture.recipientPlayer, ...extra]
    await checked(fixture.admin.from('roster_players').insert(extra.map((player, index) => ({ league_id: fixture.league.id,
        league_season_id: fixture.currentSeason.id, member_id: index ? fixture.recipient.id : fixture.proposer.id,
        player_id: player.id, acquired_via: 'draft' }))))
    await checked(fixture.admin.from('trade_block_items').insert(roster.map((player, index) => ({ league_id: fixture.league.id,
        member_id: index % 2 ? fixture.recipient.id : fixture.proposer.id, player_id: player.id }))))
    const acceptedAt = new Date().toISOString()
    const trade = await checked(fixture.admin.from('trades').insert({ league_id: fixture.league.id,
        league_season_id: fixture.currentSeason.id, proposer_member_id: fixture.proposer.id, recipient_member_id: fixture.recipient.id,
        status: 'accepted', accepted_at: acceptedAt, veto_window_expires_at: new Date(Date.now() + 86400000).toISOString() }).select('id').single())
    await checked(fixture.admin.from('trade_participants').insert([fixture.proposer, fixture.recipient].map((member, index) => ({
        trade_id: trade.id, member_id: member.id, sort_order: index, is_initiator: !index, accepted_at: acceptedAt }))))
    const terms = [fixture.proposerPlayer, fixture.recipientPlayer].map((player, index) => ({
        fromMemberId: index ? fixture.recipient.id : fixture.proposer.id, toMemberId: index ? fixture.proposer.id : fixture.recipient.id,
        playerId: player.id, pickId: null, faabAmount: 0,
    }))
    await checked(fixture.admin.from('trade_items').insert(terms.map((term, index) => ({ trade_id: trade.id, side: index ? 'recipient' : 'proposer',
        player_id: term.playerId, from_member_id: term.fromMemberId, to_member_id: term.toMemberId }))))
    const quote = await checked(fixture.admin.rpc('save_trade_estimate_quote', { p_user_id: fixture.proposer.user_id,
        p_member_id: fixture.proposer.id, p_model_version: 'ux-fixture-v1', p_inputs: { leagueId: fixture.league.id,
            seasonId: fixture.currentSeason.id, seasonYear: fixture.currentSeason.season_year, terms },
        p_analysis: { confidence: 1, strategy: 'balanced', assets: [], teams: [fixture.proposer, fixture.recipient].map((member, index) => ({
            memberId: member.id, valuesSent: index ? 605 : 1412, valuesReceived: index ? 1412 : 605,
            impact: index ? 677 : -677, shortTermPoints: 0, longTermValue: 0, packageEffect: 0, replacementEffect: 0, rosterSlotEffect: 0 })) } }))
    await checked(fixture.admin.from('trade_estimates').insert({ trade_id: trade.id, quote_id: quote.id }))
    const state = path.join(args.output, 'fixture.json')
    await writeFile(state, JSON.stringify({ leagueId: fixture.league.id, users: fixture.users, password: fixture.password,
        playerId: freePlayer.id, playerName: freePlayer.display_name, playerIds: [...roster.map(player => player.id), freePlayer.id] }), { mode: 0o600 })
    const build = () => run('npx', ['expo', 'export', '--platform', 'web', '--clear'], { env: { ...env, PATH: process.env.PATH,
        EXPO_NO_TELEMETRY: '1', CI: '1', PANCAKE_PREVIOUS_RELEASE_ROOT: path.resolve('../../repo/dist') } })
    const capture = async (label, port) => {
        const server = spawn(process.execPath, ['tests/e2e/static-web-server.mjs', '--root=dist', `--port=${port}`, '--host=127.0.0.1'], { stdio: 'inherit' })
        const serverExited = new Promise(resolve => server.once('exit', resolve))
        await writeFile(path.join(args.output, `${label}-server.pid`), String(server.pid))
        try {
            let ready = false
            for (let attempt = 0; attempt < 50; attempt++) {
                assert.equal(server.exitCode, null, 'The static server exits before becoming ready')
                if (await originalFetch(`http://127.0.0.1:${port}`).then(response => response.ok).catch(() => false)) { ready = true; break }
                await new Promise(resolve => setTimeout(resolve, 100))
            }
            assert.ok(ready)
            await run(process.execPath, ['tests/e2e/ux-round2.mjs', `--env=${args.env}`, `--state=${state}`,
                `--url=http://127.0.0.1:${port}`, `--output=${path.join(args.output, label)}`, `--label=${label}`],
                { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } })
        } finally {
            server.kill('SIGTERM')
            await serverExited
        }
    }
    if (args.prepared !== 'true') {
        await build()
        await capture('before', 58996)
        await run('git', ['apply', args.patch])
        await run('tar', ['-xf', args.files])
        await build()
    }
    await capture('after', 58997)
})
