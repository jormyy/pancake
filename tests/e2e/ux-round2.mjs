import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { devices } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { openWebTarget, WEB_TARGETS, navigateWebTarget, waitForWebTargetReads, pressWebControl } from './web-targets-browser.mjs'
import { stackEnvironment, requireSweepStack, resolveSweepPorts } from './layout-stability-ports.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)))
const env = await stackEnvironment(args.env)
env.E2E_FRONTEND_URL = args.url
env.LAYOUT_STABILITY_FRONTEND_PORT = new URL(args.url).port
requireSweepStack(env, resolveSweepPorts({}, env))
const state = JSON.parse(await readFile(args.state, 'utf8'))
const auth = createClient(env.E2E_SUPABASE_URL, env.E2E_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const { data, error } = await auth.auth.signInWithPassword({ email: state.users[0].email, password: state.password })
assert.ifError(error)
const members = await auth.from('league_members').select('id').eq('league_id', state.leagueId).eq('user_id', state.users[0].id).single()
assert.ifError(members.error)
const target = WEB_TARGETS.find(row => row.engine === 'webkit' && row.viewport.width === 390 && row.viewport.height === 844 && !row.standalone)
assert.ok(target)
await mkdir(args.output, { recursive: true })
const localStorage = [
    { name: `sb-${new URL(env.E2E_SUPABASE_URL).hostname.split('.')[0]}-auth-token`, value: JSON.stringify(data.session) },
    { name: `pancake:selected-league:v1:${state.users[0].id}`, value: JSON.stringify({ version: 1, savedAt: Date.now(), value: members.data.id }) },
]
const client = await openWebTarget(target, args.output, { ...devices['iPhone 14'], viewport: target.viewport, serviceWorkers: 'block', storageState: { cookies: [], origins: [{ origin: env.E2E_FRONTEND_URL, localStorage }] } })
const errors = []
const screens = []
client.page.on('pageerror', error => errors.push(error.message))
await client.context.route('**/*', route => {
    const url = new URL(route.request().url())
    return ['127.0.0.1', 'localhost', 'cdn.nba.com'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol)
        ? route.continue() : route.abort('blockedbyclient')
})
const capture = async name => {
    await waitForWebTargetReads(client.page)
    const text = await client.page.locator('[role="main"]').innerText()
    const geometry = await client.page.evaluate(() => ({ card: (() => { const card = document.querySelector('[data-testid^="trade-analyze-"]')?.parentElement?.parentElement?.parentElement; return card ? { height: card.getBoundingClientRect().height, top: card.getBoundingClientRect().top } : null })(), width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
        tabs: [...document.querySelectorAll('[role="tab"]')].filter(node => node.getBoundingClientRect().height > 0).map(node => node.textContent),
        rows: [...document.querySelectorAll('[data-testid="player-row-content"]')].filter(node => node.getBoundingClientRect().height > 0).map(node => ({ text: node.textContent, height: node.getBoundingClientRect().height })) }))
    await writeFile(path.join(args.output, `${name}.txt`), text)
    await client.page.screenshot({ path: path.join(args.output, `${name}.png`) })
    screens.push({ name, geometry })
    if (args.label === 'after') {
        assert.equal(geometry.height, 844, `${name} viewport height`)
        assert.equal(geometry.overflow, false, `${name} overflows`)
        assert.doesNotMatch(text, /Sleeper \(RotoWire\)|Updated \w|Sources:/)
    }
    return text
}
const visit = async route => {
    await navigateWebTarget(client.page, new URL(route, env.E2E_FRONTEND_URL).href)
    await client.page.getByRole('navigation', { name: 'Primary', exact: true }).waitFor()
    await waitForWebTargetReads(client.page)
}
try {
    await visit('/trades?tab=history')
    const history = await capture('trades-history')
    assert.match(history, /Revalue/)
    if (args.label === 'after') {
        assert.doesNotMatch(history, /What happened\?|Saved |Saved estimate and sources|: sent /)
        assert.match(history, /\d+ vs \d+/)
        assert.ok(screens.at(-1).geometry.card.height < 350, 'The history card has an oversized asset section')
        const total = await client.page.getByText('1412 vs 605', { exact: true }).boundingBox()
        assert.ok(total && total.y + total.height < 710, 'The value total must fit above the bottom tabs')
        assert.deepEqual(screens.at(-1).geometry.tabs.map(text => text.replace(/\d+/g, '').trim()), ['Offers', 'Block', 'History', 'Analyzer'])
    }
    await pressWebControl(target, client.page.getByRole('button', { name: /Revalue trade from/ }).first())
    if (args.label === 'after') await client.page.getByLabel('Dynasty trade analysis', { exact: true }).waitFor()
    await capture('trade-analyzer')
    if (args.label === 'after') {
        assert.equal(await client.page.getByRole('button', { name: 'Back to trades', exact: true }).count(), 0)
        assert.doesNotMatch(await client.page.locator('[role="main"]').innerText(), /Current values for the original trade terms/)
        await pressWebControl(target, client.page.getByRole('tab', { name: 'Offers', exact: true }))
        await pressWebControl(target, client.page.getByRole('tab', { name: 'Analyzer', exact: true }))
        await waitForWebTargetReads(client.page)
        assert.equal(await client.page.getByRole('tab', { name: 'Analyzer', selected: true }).count(), 1)
    }
    await visit('/players')
    await client.page.getByRole('textbox', { name: 'Search players', exact: true }).fill(state.playerName)
    await client.page.getByRole('button', { name: `Open ${state.playerName}`, exact: true }).first().waitFor()
    const players = await capture('players')
    if (args.label === 'after') assert.match(players, /29\s+Yr 9/)
    const player = client.page.getByRole('button', { name: `Open ${state.playerName}`, exact: true }).first()
    await pressWebControl(target, player)
    const profile = await capture('player-page')
    if (args.label === 'after') assert.match(profile, /29\s+Yr 9/)
    await visit('/trades?tab=block')
    await capture('league-listings')
    const listings = client.page.getByText('Your listings', { exact: true })
    await listings.scrollIntoViewIfNeeded()
    await capture('your-listings')
    assert.deepEqual(errors, [])
} catch (error) {
    await writeFile(path.join(args.output, 'failure.txt'), `${String(error)}\n${await client.page.locator('body').innerText()}`)
    await client.page.screenshot({ path: path.join(args.output, 'failure.png') })
    throw error
} finally {
    await writeFile(path.join(args.output, 'report.json'), JSON.stringify({ device: 'iPhone 14', engine: target.engine, viewport: target.viewport, label: args.label, screens, errors }, null, 2))
    await client.context.close()
    await client.browser.close()
    await auth.auth.signOut({ scope: 'local' })
}
