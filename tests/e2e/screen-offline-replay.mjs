import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { openWebTarget, WEB_TARGETS, navigateWebTarget, waitForWebTargetReads, pressWebControl } from './web-targets-browser.mjs'
import { stackEnvironment, requireSweepStack } from './layout-stability-ports.mjs'
const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)))
const env = await stackEnvironment(args.env)
requireSweepStack(env)
const state = JSON.parse(await readFile(args.state, 'utf8'))
const admin = createClient(env.E2E_SUPABASE_URL, env.E2E_PANCAKE_SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
const auth = createClient(env.E2E_SUPABASE_URL, env.E2E_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } })
const { data: { session }, error } = await auth.auth.signInWithPassword({ email: state.users[0].email, password: state.password })
assert.ifError(error)
const { data: member } = await admin.from('league_members').select('id').eq('league_id', state.leagueId).eq('user_id', state.users[0].id).single()
const { data: player } = await admin.from('players').select('id').eq('sportsdata_id', 'e2e-player-026').single()
assert.ok(member && player)
const { data: prior } = await admin.from('waiver_claims').select('id').eq('member_id', member.id).eq('player_id', player.id).eq('status', 'pending')
assert.equal(prior.length, 0, 'Use a clean synthetic claim fixture')
await mkdir(args.output, { recursive: true })
const target = WEB_TARGETS.find(row => row.engine === 'webkit' && row.viewport.width === 390 && !row.standalone)
const storedSession = [{ name: `sb-${new URL(env.E2E_SUPABASE_URL).hostname.split('.')[0]}-auth-token`, value: JSON.stringify(session) }, { name: `pancake:selected-league:v1:${session.user.id}`, value: JSON.stringify({ version: 1, savedAt: Date.now(), value: member.id }) }]
const client = await openWebTarget(target, args.output, { serviceWorkers: 'block', storageState: { cookies: [], origins: [{ origin: env.E2E_FRONTEND_URL, localStorage: storedSession }] } })
const ids = []
let failReplay = false
try {
    await client.context.route('**/*', async route => {
        const request = route.request()
        const url = new URL(request.url())
        if (failReplay && url.pathname.endsWith('/waivers/claims')) {
            if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
            ids.push(request.headers()['x-request-id'])
            return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, json: { error: 'Synthetic lost response' } })
        }
        return [new URL(env.E2E_FRONTEND_URL).origin, new URL(env.E2E_SUPABASE_URL).origin].includes(url.origin) ? route.continue() : route.abort()
    })
    await navigateWebTarget(client.page, new URL(`/claim-player?playerId=${player.id}`, env.E2E_FRONTEND_URL).href)
    const submit = client.page.getByRole('button', { name: 'Submit waiver claim', exact: true })
    await submit.waitFor()
    await client.page.waitForFunction(() => { const button = document.querySelector('[aria-label="Submit waiver claim"]'); return button && button.getAttribute('aria-disabled') !== 'true' })
    await waitForWebTargetReads(client.page)
    await client.context.setOffline(true)
    await client.page.getByText('Offline · showing saved data', { exact: true }).waitFor()
    await pressWebControl(target, submit)
    await client.page.getByText('1 action pending', { exact: true }).waitFor()
    const saved = await client.page.evaluate(() => JSON.parse(localStorage.getItem('pancake:offline-mutations:v1') ?? '[]'))
    assert.equal(saved.length, 1)
    const originalBody = saved[0].body
    const id = saved[0].id
    failReplay = true
    await client.context.setOffline(false)
    await client.page.getByRole('button', { name: 'Retry saved action', exact: true }).waitFor()
    const failed = await client.page.evaluate(() => JSON.parse(localStorage.getItem('pancake:offline-mutations:v1') ?? '[]'))
    assert.equal(failed[0].body, originalBody)
    assert.equal(failed[0].id, id)
    assert.ok(ids.length > 0, 'The replay failure must reach the interceptor')
    failReplay = false
    await pressWebControl(target, client.page.getByRole('button', { name: 'Retry saved action', exact: true }))
    await client.page.waitForFunction(() => JSON.parse(localStorage.getItem('pancake:offline-mutations:v1') ?? '[]').length === 0)
    const { data: claims, error: readError } = await admin.from('waiver_claims').select('id').eq('member_id', member.id).eq('player_id', player.id).eq('status', 'pending')
    assert.ifError(readError)
    assert.equal(claims.length, 1)
    const response = await fetch(`${env.E2E_API_BASE_URL}/waivers/claims`, { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'x-request-id': id, 'Content-Type': 'application/json' }, body: originalBody })
    assert.equal(response.ok, true)
    const { data: repeated } = await admin.from('waiver_claims').select('id').eq('member_id', member.id).eq('player_id', player.id).eq('status', 'pending')
    assert.equal(repeated.length, 1)
    assert.ok(ids.every(value => value === id))
    await writeFile(`${args.output}/report.json`, JSON.stringify({ queued: 1, retainedFailedInput: true, stableRequestId: true, claimsAfterReplayAndDuplicate: repeated.length }, null, 2))
    await admin.from('waiver_claims').delete().eq('id', claims[0].id)
} catch (error) {
    await writeFile(`${args.output}/failure-state.json`, JSON.stringify({ intercepted: ids.length, queue: await client.page.evaluate(() => JSON.parse(localStorage.getItem('pancake:offline-mutations:v1') ?? '[]')).then(jobs => jobs.map(job => ({ status: job.status, error: job.error }))) }, null, 2))
    await writeFile(`${args.output}/failure.txt`, await client.page.locator('body').innerText())
    await client.page.screenshot({ path: `${args.output}/failure.png`, fullPage: true })
    throw error
} finally { await client.context.close(); await client.browser.close() }
