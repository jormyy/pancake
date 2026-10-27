import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { openWebTarget, WEB_TARGETS, navigateWebTarget, waitForWebTargetReads, pressWebControl, pinWebTargetLeague } from './web-targets-browser.mjs'
import { stackEnvironment, requireSweepStack } from './layout-stability-ports.mjs'
import { createDisposableLeagueFromSeedUsers, currentSeasonYear } from './soak-fixtures.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)))
const env = await stackEnvironment(args.env)
requireSweepStack(env)
const state = JSON.parse(await readFile(args.state, 'utf8'))
const admin = createClient(env.E2E_SUPABASE_URL, env.E2E_PANCAKE_SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
const checked = async operation => { const { data, error } = await operation; assert.ifError(error); return data }
const auth = createClient(env.E2E_SUPABASE_URL, env.E2E_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } })
const { session } = await checked(auth.auth.signInWithPassword({ email: state.users[0].email, password: state.password }))
const member = await checked(admin.from('league_members').select('id,leagues!league_members_league_id_fkey(name)').eq('league_id', state.leagueId).eq('user_id', state.users[0].id).single())
await mkdir(args.output, { recursive: true })
await runWithScenarioResourceOwner('screen cache identity', async resourceOwner => {
    const empty = await createDisposableLeagueFromSeedUsers({ supabase: admin, state, season: 0, seasonYear: currentSeasonYear(), label: 'cache identity', userCount: 1, resourceOwner })
    const target = WEB_TARGETS.find(row => row.engine === 'webkit' && row.viewport.width === 390 && !row.standalone)
    const storedSession = [{ name: `sb-${new URL(env.E2E_SUPABASE_URL).hostname.split('.')[0]}-auth-token`, value: JSON.stringify(session) }, { name: `pancake:selected-league:v1:${session.user.id}`, value: JSON.stringify({ version: 1, savedAt: Date.now(), value: member.id }) }]
    const client = await openWebTarget(target, args.output, { storageState: { cookies: [], origins: [{ origin: env.E2E_FRONTEND_URL, localStorage: storedSession }] } })
    const caches = () => client.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pancake:screen-view:v1:')).map(key => JSON.parse(localStorage.getItem(key)).scope))
    try {
        await client.context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort())
        await navigateWebTarget(client.page, new URL('/roster', env.E2E_FRONTEND_URL).href)
        await client.page.getByText('E2E Player001', { exact: true }).waitFor()
        assert.ok((await caches()).some(scope => scope.leagueId === state.leagueId))
        await pinWebTargetLeague(target, client.page, { userId: session.user.id, memberId: empty.members[0].id, leagueName: empty.league.name })
        await waitForWebTargetReads(client.page)
        assert.equal(await client.page.getByText('E2E Player001', { exact: true }).count(), 0)
        assert.ok((await caches()).every(scope => scope.leagueId === empty.league.id))
        await pinWebTargetLeague(target, client.page, { userId: session.user.id, memberId: member.id, leagueName: member.leagues.name })
        await client.page.getByText('E2E Player001', { exact: true }).waitFor()
        await navigateWebTarget(client.page, new URL('/profile', env.E2E_FRONTEND_URL).href)
        await pressWebControl(target, client.page.getByRole('button', { name: 'Sign out', exact: true }))
        await pressWebControl(target, client.page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }))
        await client.page.getByPlaceholder('you@example.com').waitFor()
        assert.deepEqual(await caches(), [])
        await client.page.getByPlaceholder('you@example.com').fill(state.users[1].email)
        await client.page.locator('input[type="password"]').fill(state.password)
        await pressWebControl(target, client.page.getByRole('button', { name: 'Sign In', exact: true }))
        await client.page.getByRole('navigation', { name: 'Primary', exact: true }).waitFor()
        await navigateWebTarget(client.page, new URL('/roster', env.E2E_FRONTEND_URL).href)
        await client.page.getByText('E2E Player011', { exact: true }).waitFor()
        assert.equal(await client.page.getByText('E2E Player001', { exact: true }).count(), 0)
        assert.ok((await caches()).length > 0)
        assert.ok((await caches()).every(scope => scope.accountId === state.users[1].id))
        await writeFile(`${args.output}/report.json`, JSON.stringify({ leagueSwitchClearsPrivateCache: true, signOutClearsPrivateCache: true, nextAccountShowsOnlyItsRoster: true }, null, 2))
    } catch (error) {
        await writeFile(`${args.output}/failure.txt`, await client.page.locator('body').innerText())
        await client.page.screenshot({ path: `${args.output}/failure.png`, fullPage: true })
        throw error
    } finally { await client.context.close(); await client.browser.close() }
})
