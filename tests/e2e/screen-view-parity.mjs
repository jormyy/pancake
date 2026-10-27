import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { openWebTarget, WEB_TARGETS, navigateWebTarget, waitForWebTargetReads } from './web-targets-browser.mjs'
import { prepareSweepFixtures } from './layout-stability-fixtures.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { stackEnvironment, resolveSweepPorts, requireSweepStack } from './layout-stability-ports.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)))
const env = await stackEnvironment(args.env)
const ports = resolveSweepPorts({}, env)
requireSweepStack(env, ports)
const output = path.resolve(args.output)
const frontend = env.E2E_FRONTEND_URL
const target = WEB_TARGETS.find(row => row.engine === 'webkit' && row.viewport.width === 390 && row.viewport.height === 844 && !row.standalone)
assert.ok(target, 'The project needs the 390x844 WebKit target')
await mkdir(output, { recursive: true })
const normalize = text => text.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\b/g, '<time>').replace(/\b\d+\s*(?:second|minute|hour|day|week|m|s|h|d|w)s?\s+ago\b/g, '<age>')

await runWithScenarioResourceOwner('screen view parity', async resourceOwner => {
    const fixture = await prepareSweepFixtures({ env, statePath: args.state, resourceOwner, ports })
    const routes = [['home', '/'], ['roster', '/roster'], ['players', '/players'], ['waivers', '/players?section=waivers'], ['player', `/player/${fixture.rosterPlayer}`], ['trades-offers', '/trades'], ['trades-history', '/trades?tab=history'], ['trade-block', '/trades?tab=block'], ...['results', 'history', 'draftBoard', 'settings', 'mockRooms', 'auctions'].map(tab => [`league-${tab}`, `/league?tab=${tab}`]), ['lineup', '/lineup'], ['claim-editor', `/claim-player?playerId=${fixture.player}`], ['auction', `/draft-room?draftId=${fixture.auction}`], ['rookie', `/rookie-draft-room?draftId=${fixture.rookie}`], ['profile', '/profile'], ['team-roster', `/team-roster?memberId=${fixture.other.id}`]]
    const capture = async label => {
        const directory = path.join(output, label)
        await mkdir(directory, { recursive: true })
        const session = await fixture.sessionForBrowser()
        const localStorage = [{ name: `sb-${new URL(env.E2E_SUPABASE_URL).hostname.split('.')[0]}-auth-token`, value: JSON.stringify(session) }, { name: `pancake:selected-league:v1:${fixture.me.user_id}`, value: JSON.stringify({ version: 1, savedAt: Date.now(), value: fixture.me.id }) }]
        const client = await openWebTarget(target, directory, { storageState: { cookies: [], origins: [{ origin: frontend, localStorage }] } })
        const report = []
        try {
            await client.context.route('**/*', route => {
                const url = new URL(route.request().url())
                return ['127.0.0.1', 'localhost'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort('blockedbyclient')
            })
            for (const [screen, route] of routes) {
                const requests = []
                const errors = []
                const request = value => { const url = new URL(value.url()); if (/\/(rest|functions)\/v1\//.test(url.pathname) && value.method() !== 'OPTIONS') requests.push(url.pathname) }
                const error = value => errors.push(value.message)
                client.page.on('request', request)
                client.page.on('pageerror', error)
                try {
                    await navigateWebTarget(client.page, new URL(route, frontend).href)
                    await waitForWebTargetReads(client.page)
                    await client.page.waitForFunction(({ screen }) => {
                        const text = document.body.innerText
                        if (screen === 'home') return text.includes('E. Player001')
                        if (screen === 'roster' || screen === 'trade-block' || screen === 'lineup' || screen === 'player') return text.includes('E2E Player001')
                        if (screen === 'auction' || screen === 'league-results') return text.includes('E2E Team 1')
                        if (screen === 'claim-editor') return text.includes('E2E Player026')
                        return text.trim().length > 80
                    }, { screen }, { timeout: 20000 })
                    await waitForWebTargetReads(client.page)
                    const text = normalize(await client.page.locator('body').innerText())
                    assert.ok(text.trim().length > 80, `${screen} has no rendered content`)
                    await writeFile(path.join(directory, `${screen}.txt`), text)
                    await client.page.screenshot({ path: path.join(directory, `${screen}.png`), fullPage: true })
                    report.push({ screen, route, requests, errors, bytes: text.length, digest: createHash('sha256').update(text).digest('hex') })
                } finally { client.page.off('request', request); client.page.off('pageerror', error) }
            }
        } finally { await client.context.close(); await client.browser.close() }
        await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
        return report
    }
    const before = args.baseline ? JSON.parse(await readFile(path.join(args.baseline, 'report.json'), 'utf8')) : await capture('before')
    if (args.baseline) for (const row of before) row.digest = createHash('sha256').update(normalize(await readFile(path.join(args.baseline, `${row.screen}.txt`), 'utf8'))).digest('hex')
    await writeFile(path.join(output, 'before.ready'), 'ready\n')
    if (!args['wait-for'] && !args.baseline) return
    while (args['wait-for']) {
        try { await access(args['wait-for']); break } catch {}
        await new Promise(resolve => setTimeout(resolve, 1000))
    }
    const after = await capture(args.label ?? 'after')
    const differences = after.flatMap((row, index) => row.digest !== before[index].digest || row.errors.length > 0 ? [{ screen: row.screen, before: before[index].requests.length, after: row.requests.length, errors: row.errors }] : [])
    const requestBudgets = after.map(row => ({ screen: row.screen,
        views: row.requests.filter(request => request.includes('/views/')).length,
        versions: row.requests.filter(request => request.endsWith('/version')).length,
        other: row.requests.filter(request => !request.includes('/views/') && !request.endsWith('/version') && !['/rest/v1/league_members', '/rest/v1/league_change_hints'].includes(request)),
    }))
    await writeFile(path.join(output, 'comparison.json'), JSON.stringify({ viewport: target.viewport, differences, requestBudgets, screens: after.map((row, index) => ({ screen: row.screen, before: before[index].requests.length, after: row.requests.length, unchanged: row.digest === before[index].digest })) }, null, 2))
    assert.deepEqual(differences, [], 'Rendered screen text changes or a screen has script errors')
    assert.deepEqual(requestBudgets.filter(row => row.views !== (row.screen === 'league-auctions' ? 0 : 1) || row.versions !== (row.screen === 'profile' ? 0 : 1) || row.other.length), [], 'A screen exceeds one view and one version check')
})
