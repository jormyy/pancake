import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { gzipSync } from 'node:zlib'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'
import { labRoot, requireMini } from '../../scripts/perf-lab/common.mjs'
import {
    localKeys,
    sql,
    statementSnapshot,
    statementDelta,
} from '../../scripts/perf-lab/database.mjs'

await requireMini()
assert.equal(process.env.PERF_LAB_PROJECT, 'pt4bafablerq')
assert.equal(process.env.PERF_LAB_PORT_PREFIX, '633')
const [label = 'before', round = '1', mode = 'walk'] = process.argv.slice(2)
assert.match(label, /^[a-z0-9-]+$/)
assert.match(round, /^\d+$/)
const { origin, fixture } = JSON.parse(await readFile(path.join(labRoot, 'ready.json'), 'utf8'))
const hostname = new URL(origin).hostname
const keys = await localKeys()
const requestRoleIds = JSON.parse(
    await sql(
        "SELECT json_agg(oid::text) FROM pg_roles WHERE rolname IN ('authenticator','authenticated','anon','service_role','supabase_auth_admin')",
    ),
)
const authRoleId = await sql("SELECT oid::text FROM pg_roles WHERE rolname='supabase_auth_admin'")
const requestDbMs = (statements) =>
    statements
        .filter(
            (statement) =>
                statement.toplevel &&
                (statement.query.includes('pgrst_source') ||
                    (statement.userid === authRoleId && /^SELECT\s/i.test(statement.query.trim()))),
        )
        .reduce((sum, statement) => sum + statement.total_exec_time, 0)
const client = createClient(keys.API_URL, keys.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
})
const login = await client.auth.signInWithPassword({
    email: fixture.users[0].email,
    password: fixture.password,
})
assert.ifError(login.error)
const matchup = await sql(
    `SELECT id FROM public.matchups WHERE league_id='${fixture.leagueId}' AND home_member_id='${fixture.members[0].id}' ORDER BY week_number LIMIT 1`,
)
const directory = path.join(labRoot, 'requests', `${label}-${round}-${mode}`)
await mkdir(directory, { recursive: true })
const artifact = JSON.parse(
    await readFile(path.join(labRoot, 'web-export/release-provenance.json'), 'utf8'),
)
const buildLabel = label.startsWith('trim-')
    ? 'after'
    : label.startsWith('legacy-')
      ? 'before'
      : label
const expectedArtifact = JSON.parse(
    await readFile(path.join(labRoot, `${buildLabel}-export/release-provenance.json`), 'utf8'),
)
assert.equal(artifact.commitSha, expectedArtifact.commitSha)
const exec = promisify(execFile)
const session = `l5c-${label}-${round}-${mode}`
const agent = async (args) =>
    (
        await exec('agent-browser', ['--session', session, ...args], {
            timeout: 60000,
            maxBuffer: 4 * 1024 * 1024,
        })
    ).stdout
const report = {
    label,
    round,
    mode,
    buildSha: artifact.commitSha,
    requestRoleIds,
    authRoleId,
    startedAt: new Date().toISOString(),
    rows: [],
    errors: [],
    blocked: [],
}
const retryScreens = process.env.L5C_RETRY_SCREENS?.split(',')
if (retryScreens) {
    const previous = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'))
    Object.assign(report, previous)
    report.authRoleId = authRoleId
    report.rejectedRows = [
        ...(previous.rejectedRows ?? []),
        ...previous.rows.filter((row) => retryScreens.includes(row.screen)),
    ]
    report.rows = previous.rows.filter((row) => !retryScreens.includes(row.screen))
    report.recoveryStartedAt = new Date().toISOString()
}
let browser,
    page,
    context,
    current,
    tasks = []
const save = () => writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
const settle = async () => {
    await page.waitForFunction(
        () =>
            !document.getElementById('pancake-boot-shell') &&
            (document.getElementById('root')?.textContent?.length ?? 0) > 60,
        undefined,
        { timeout: 45000 },
    )
    await page.waitForLoadState('networkidle', { timeout: 30000 })
    await delay(500)
    await Promise.all(tasks)
}
const measure = async (screen, state, action, duration = 0) => {
    const before = await statementSnapshot()
    const row = { screen, state, requests: [], seconds: 0, startedAt: Date.now() }
    current = row
    tasks = []
    const started = Date.now()
    try {
        await action()
        if (duration) {
            row.minutes = []
            let previous = before
            let minuteStart = started
            for (let minute = 1; minute <= duration; minute++) {
                await delay(60000)
                await Promise.all(tasks)
                const minuteEnd = Date.now()
                const snapshot = await statementSnapshot()
                const requests = row.requests.filter(
                    (request) => request.at >= minuteStart && request.at < minuteEnd,
                )
                const statements = statementDelta(previous, snapshot)
                row.minutes.push({
                    minute,
                    seconds: (minuteEnd - minuteStart) / 1000,
                    requests: requests.length,
                    rawBytes: requests.reduce((sum, request) => sum + request.rawBytes, 0),
                    wireBytes: requests.reduce((sum, request) => sum + request.wireBytes, 0),
                    dbMs: requestDbMs(statements),
                })
                previous = snapshot
                minuteStart = minuteEnd
                console.log(`${label} ${screen} idle minute ${minute}/${duration}`)
            }
        } else await settle()
        await Promise.all(tasks)
        row.text = (await page.locator('#root').innerText()).slice(0, 240)
        row.selectedTabs = await page
            .locator('[role="tab"][aria-selected="true"]')
            .evaluateAll((elements) => elements.map((element) => element.id))
        row.url = new URL(page.url()).pathname
        row.seconds = (Date.now() - started) / 1000
        row.statements = statementDelta(before, await statementSnapshot())
        row.dbMs = requestDbMs(row.statements)
        row.rawBytes = row.requests.reduce((sum, request) => sum + request.rawBytes, 0)
        row.wireBytes = row.requests.reduce((sum, request) => sum + request.wireBytes, 0)
        row.gzipBytes = row.requests.reduce((sum, request) => sum + request.gzipBytes, 0)
        row.requestCount = row.requests.length
        row.failed = row.requests.filter((request) => request.status >= 400)
        current = null
        if (round === '1' || mode.startsWith('idle-')) {
            await agent(['screenshot', path.join(directory, `${screen}-${state}.png`)])
            await writeFile(
                path.join(directory, `${screen}-${state}.txt`),
                await agent(['snapshot']),
            )
        }
        console.log(
            `${label}/${round} ${screen}/${state}: ${row.requestCount} requests ${row.rawBytes} bytes ${row.dbMs.toFixed(2)} DB ms`,
        )
    } catch (error) {
        row.error = error.message
        console.error(`${screen}/${state}: ${error.message}`)
    } finally {
        current = null
        report.rows.push(row)
        await save()
    }
}
const click = (selector) => agent(['click', selector])
const button = (name) => click(`[role="button"][aria-label=${JSON.stringify(name)}]`)
const open = (route) => agent(['open', `${origin}${route}`])
const clear = () =>
    page.evaluate(() => {
        for (const key of Object.keys(localStorage))
            if (!key.endsWith('-auth-token') && key !== 'pancake-theme')
                localStorage.removeItem(key)
    })
try {
    await exec(
        'agent-browser',
        [
            '--session',
            session,
            '--ignore-https-errors',
            '--args',
            `--host-resolver-rules=MAP ${hostname} 127.0.0.1`,
            '--allowed-domains',
            `127.0.0.1,localhost,${hostname}`,
            'open',
            `${origin}/release-provenance.json`,
        ],
        { timeout: 60000 },
    )
    const endpoint = (await agent(['get', 'cdp-url'])).match(/ws:\/\/\S+/)?.[0]
    assert.ok(endpoint)
    browser = await chromium.connectOverCDP(endpoint)
    context = browser.contexts()[0]
    page = context.pages().find((candidate) => candidate.url().startsWith(origin))
    assert.ok(page)
    await context.route('**/*', (route) => {
        const url = new URL(route.request().url())
        if (url.origin === origin || url.protocol === 'data:' || url.protocol === 'blob:')
            return route.continue()
        report.blocked.push(`${url.origin}${url.pathname}`)
        return route.abort()
    })
    await context.addInitScript(
        ({ session, key }) => {
            if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(session))
            localStorage.setItem('pancake-theme', 'light')
        },
        { session: login.data.session, key: `sb-${hostname.split('.')[0]}-auth-token` },
    )
    await agent(['set', 'viewport', '390', '844'])
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    page.on('pageerror', (error) => report.errors.push(error.message))
    page.on('requestfailed', (request) => {
        const url = new URL(request.url())
        if (
            current &&
            url.origin === origin &&
            /^\/(rest|functions|auth)\/v1\//.test(url.pathname)
        ) {
            current.failedRequests ??= []
            current.failedRequests.push({ path: url.pathname, error: request.failure()?.errorText })
        }
    })
    page.on('response', (response) => {
        const url = new URL(response.url())
        if (
            url.origin !== origin ||
            !/^\/(rest|functions|auth)\/v1\//.test(url.pathname) ||
            !current
        )
            return
        const row = current
        const at = Date.now()
        tasks.push(
            (async () => {
                const body = await response.body().catch(() => Buffer.alloc(0))
                const sizes = await response.request().sizes()
                row.requests.push({
                    path: url.pathname,
                    method: response.request().method(),
                    status: response.status(),
                    at,
                    rawBytes: body.length,
                    wireBytes: sizes.responseBodySize,
                    gzipBytes: gzipSync(body).length,
                    contentEncoding: response.headers()['content-encoding'] ?? 'identity',
                })
            })(),
        )
    })
    const routes = [
        ['home', '/'],
        ['matchup', `/matchup?matchupId=${matchup}`],
        ['lineup', '/lineup'],
        ['roster', '/roster'],
        ['moves', '/players?section=waivers'],
        ['players', '/players'],
        ['player', `/player/${fixture.players[220].id}`],
        ['trades', '/trades'],
        ['compose', `/propose-trade?recipientMemberId=${fixture.members[1].id}`],
        ['analyzer', '/trades?tab=analyzer'],
        ['league', '/league'],
        ['standings', '/league?tab=results'],
        ['activity', '/league?tab=history'],
        ['picks', '/league?tab=picks'],
        ['schedule', '/league?tab=schedule'],
        ['draft', '/league?tab=draft'],
        ['bracket', '/bracket'],
        ['settings', '/league?tab=settings'],
        ['profile', '/profile'],
        ['notifications', '/notification-settings'],
        ['commissioner-settings', '/commissioner-settings'],
        ['team-roster', `/team-roster?memberId=${fixture.members[1].id}`],
        ['claim-player', `/claim-player?playerId=${fixture.players[230].id}`],
        ['timeline', '/timeline'],
        ['dynasty', '/dynasty'],
        ['draft-launcher', '/draft'],
        [
            'auction-room',
            `/draft-room?draftId=${fixture.drafts.find((draft) => draft.draft_type === 'auction').id}`,
        ],
        [
            'rookie-room',
            `/rookie-draft-room?draftId=${fixture.drafts.find((draft) => draft.draft_type === 'snake').id}`,
        ],
    ]
    if (mode === 'walk' || mode === 'players') {
        for (const [name, route] of routes.filter(
            ([name]) =>
                (mode !== 'players' || name === 'players') &&
                (!retryScreens || retryScreens.includes(name)),
        )) {
            const target = new URL(route, origin)
            const section = target.searchParams.get('tab') ?? target.searchParams.get('section')
            const prefix = {
                '/league': 'league-tab',
                '/players': 'players-section',
                '/trades': 'trade-section',
            }[target.pathname]
            const selectedTab = section && prefix ? `${prefix}-${section}` : null
            const checkTab = async () => {
                if (selectedTab)
                    await page.waitForFunction(
                        (id) =>
                            document.getElementById(id)?.getAttribute('aria-selected') === 'true',
                        selectedTab,
                        { timeout: 15000 },
                    )
            }
            await clear()
            await measure(name, 'cold', async () => {
                await open(route)
                await checkTab()
            })
            const destination = {
                '/': 'Matchup',
                '/roster': 'Roster',
                '/players': 'Players',
                '/trades': 'Trades',
                '/league': 'League',
            }[new URL(route, origin).pathname]
            const away = destination === 'Matchup' ? 'Roster' : 'Matchup'
            if (selectedTab) {
                const alternate =
                    prefix === 'league-tab'
                        ? section === 'results'
                            ? 'history'
                            : 'results'
                        : prefix === 'players-section'
                          ? section === 'players'
                              ? 'waivers'
                              : 'players'
                          : section === 'offers'
                            ? 'block'
                            : 'offers'
                await click(`#${prefix}-${alternate}`)
                await settle()
                await measure(name, 'warm', async () => {
                    await click(`#${selectedTab}`)
                    await checkTab()
                })
            } else if (
                destination &&
                (await page.getByRole('link', { name: away, exact: true }).count()) === 1
            ) {
                await agent(['find', 'role', 'link', 'click', '--name', away, '--exact'])
                await settle()
                await measure(name, 'warm', () =>
                    agent(['find', 'role', 'link', 'click', '--name', destination, '--exact']),
                )
            } else await measure(name, 'warm', () => open(route))
        }
        if (!retryScreens) {
            if (mode === 'walk') {
                for (const [name, route] of routes.filter(([name]) =>
                    ['home', 'matchup'].includes(name),
                )) {
                    await open(route)
                    await settle()
                    const days = await page
                        .locator('[role="button"][aria-label]')
                        .evaluateAll((elements) =>
                            elements
                                .map((element) => element.getAttribute('aria-label'))
                                .filter((label) =>
                                    /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), /.test(
                                        label,
                                    ),
                                ),
                        )
                    for (const [index, day] of days.entries())
                        await measure(`${name}-day-${index}`, 'action', () => button(day))
                    for (const arrow of ['Previous matchup', 'Next matchup'])
                        await measure(
                            `${name}-${arrow.split(' ')[0].toLowerCase()}`,
                            'action',
                            () => button(arrow),
                        )
                }
                await open('/')
                await settle()
                await measure('lineup-options', 'action', () =>
                    button('Open auto-set lineup options'),
                )
                await measure('edit-lineup', 'action', () => button('Edit lineup manually'))
                await open('/roster')
                await settle()
                const rosterPlayer = await page
                    .locator('[role="button"][aria-label^="Open "]')
                    .first()
                    .getAttribute('aria-label')
                if (rosterPlayer)
                    await measure('roster-player-actions', 'action', () => button(rosterPlayer))
            }
            await open('/players')
            await settle()
            await measure('players-search', 'action', () =>
                agent(['fill', '[aria-label="Search players"]', fixture.players[220].display_name]),
            )
            await open('/players')
            await settle()
            await measure('players-scroll', 'action', () =>
                agent([
                    'eval',
                    `(() => {
      const elements = [...document.querySelectorAll('#root *')].filter(element => element.scrollHeight > element.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(element).overflowY) && element.querySelector('[data-testid="player-row-content"]'))
      const element = elements.at(-1)
      if (!element) throw new Error('The player list cannot scroll')
      element.scrollTop = element.scrollHeight
    })()`,
                ]),
            )
            await measure('players-filters', 'action', () => button('Show filters'))
            for (const [filter, option] of [
                ['Availability', 'My team'],
                ['Position', 'PG'],
                ['Health', 'Healthy'],
                ['Game today', 'Playing today'],
                ['Experience', 'Rookies only'],
            ]) {
                await measure(
                    `players-filter-${filter.toLowerCase().replaceAll(' ', '-')}`,
                    'action',
                    async () => {
                        const label = await page
                            .locator(`[role="button"][aria-label^="${filter}:"]`)
                            .getAttribute('aria-label')
                        await button(label)
                        await agent([
                            'find',
                            'role',
                            'button',
                            'click',
                            '--name',
                            option,
                            '--exact',
                        ])
                    },
                )
            }
            if (mode === 'walk') {
                await open(`/propose-trade?recipientMemberId=${fixture.members[1].id}`)
                await settle()
                const offered = await page
                    .locator('[role="button"][aria-label^="Select "][aria-label$=" for trade"]')
                    .first()
                    .getAttribute('aria-label')
                await measure('compose-select', 'action', () => button(offered))
                await measure('compose-analyze', 'action', () => button('Analyze trade proposal'))
                await button('Back to trade editor')
                await settle()
                await click(`[aria-label="Edit assets sent by ${fixture.users[1].teamName}"]`)
                await settle()
                const requested = await page
                    .locator('[role="button"][aria-label^="Select "][aria-label$=" for trade"]')
                    .first()
                    .getAttribute('aria-label')
                await measure('compose-request', 'action', () => button(requested))
                await measure('compose-review', 'action', () => button('Review trade proposal'))
                await open(`/player/${fixture.players[220].id}`)
                await settle()
                for (const section of ['Game log', 'News', 'League history'])
                    await measure(
                        `player-${section.toLowerCase().replaceAll(' ', '-')}`,
                        'action',
                        () => button(section),
                    )
                await open('/notification-settings')
                await settle()
                const expand = await page
                    .getByRole('button', { name: 'Expand all', exact: true })
                    .count()
                if (expand)
                    await measure('notifications-expand', 'action', () =>
                        agent([
                            'find',
                            'role',
                            'button',
                            'click',
                            '--name',
                            'Expand all',
                            '--exact',
                        ]),
                    )
                await open('/trades')
                await settle()
                const review = await page
                    .locator('[aria-label^="Show details of trade with "]')
                    .first()
                    .getAttribute('aria-label')
                    .catch(() => null)
                if (review) await measure('trade-review', 'action', () => button(review))
                else
                    report.rows.push({
                        screen: 'trade-review',
                        state: 'action',
                        error: 'No review button in fixture',
                    })
            }
        }
    } else {
        assert.ok(mode === 'idle-home' || mode === 'idle-matchup')
        const route = mode === 'idle-home' ? '/' : `/matchup?matchupId=${matchup}`
        await open(route)
        await settle()
        const text = await page.locator('#root').innerText()
        assert.ok(text.includes(fixture.users[0].teamName), 'The idle screen has no loaded matchup')
        assert.ok(
            !/Could not load|Unable to load|Something went wrong/i.test(text),
            'The idle screen shows an error',
        )
        await measure(mode, 'idle', async () => {}, 10)
    }
} finally {
    report.finishedAt = new Date().toISOString()
    await save()
    await browser?.close()
    await agent(['close']).catch(() => {})
}
