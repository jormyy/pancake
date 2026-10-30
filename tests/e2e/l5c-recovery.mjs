import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, webkit, devices } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import http from 'node:http'
import net from 'node:net'
import { labRoot, requireMini } from '../../scripts/perf-lab/common.mjs'
import { sql, localKeys } from '../../scripts/perf-lab/database.mjs'

await requireMini()
assert.equal(process.env.PERF_LAB_PROJECT, 'pt4bafablerq')
assert.equal(process.env.PERF_LAB_PORT_PREFIX, '633')
const [label = 'before', engine = 'chromium', round = '1', group = 'all'] = process.argv.slice(2)
assert.ok(['before', 'after'].includes(label))
assert.ok(['chromium', 'webkit'].includes(engine))
assert.match(round, /^\d+$/)
const groups = {
    core: ['version', 'score', 'stat', 'combined', 'silent-data'],
    pilot: ['version', 'score', 'stat', 'silent-data'],
    hints: ['version', 'score', 'stat', 'combined'],
    faults: ['silent-data', 'silent-all', 'realtime-restart', 'offline', 'hidden', 'sleep'],
    idle: ['live-idle', 'quiet-idle'],
}
const allCases = [...groups.hints, ...groups.faults, ...groups.idle]
const cases =
    group === 'all' ? allCases : (groups[group] ?? (allCases.includes(group) ? [group] : null))
assert.ok(cases)
const ready = JSON.parse(await readFile(path.join(labRoot, 'ready.json'), 'utf8'))
const { origin, fixture } = ready
const hostname = new URL(origin).hostname
const keys = await localKeys()
const auth = createClient(keys.API_URL, keys.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
})
const { data: login, error } = await auth.auth.signInWithPassword({
    email: fixture.users[0].email,
    password: fixture.password,
})
assert.ifError(error)
const matchup = await sql(
    `SELECT id FROM public.matchups WHERE league_id='${fixture.leagueId}' AND home_member_id='${fixture.members[0].id}' ORDER BY week_number LIMIT 1`,
)
const artifact = JSON.parse(
    await readFile(path.join(labRoot, 'web-export/release-provenance.json'), 'utf8'),
)
const expected = JSON.parse(
    await readFile(path.join(labRoot, `recovery-${label}-export/release-provenance.json`), 'utf8'),
)
assert.equal(artifact.commitSha, expected.commitSha)
const directory = path.join(labRoot, 'recovery', `${label}-${engine}-${round}-${group}`)
await mkdir(directory, { recursive: true })
const report = {
    label,
    engine,
    round,
    group,
    buildSha: artifact.commitSha,
    viewport: [390, 844],
    rows: [],
    startedAt: new Date().toISOString(),
}
const save = () => writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
const exec = promisify(execFile)
let proxy
const tunnels = new Set()
if (engine === 'webkit') {
    proxy = http.createServer((_request, response) => {
        response.writeHead(403)
        response.end()
    })
    proxy.on('connect', (request, client, head) => {
        const target = new URL(`https://${request.url}`)
        if (target.hostname !== hostname || target.port !== '63384') {
            client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
            return
        }
        const upstream = net.connect(63384, '127.0.0.1', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            if (head.length) upstream.write(head)
            client.pipe(upstream)
            upstream.pipe(client)
        })
        for (const socket of [client, upstream]) {
            tunnels.add(socket)
            socket.on('close', () => tunnels.delete(socket))
            socket.on('error', () => {
                client.destroy()
                upstream.destroy()
            })
        }
    })
    await new Promise((resolve, reject) => {
        proxy.once('error', reject)
        proxy.listen(63385, '127.0.0.1', resolve)
    })
}
const publish = async (points, topics = ['version']) => {
    const raw = topics.filter((topic) => topic !== 'version')
    const topic = raw.includes('stat') ? 'stat' : 'score'
    const statement = `BEGIN; SET LOCAL session_replication_role=replica;
      UPDATE public.matchups SET home_points=${points} WHERE id='${matchup}' AND league_id='${fixture.leagueId}';
      SELECT private.publish_league_version('${fixture.leagueId}',ARRAY['${topic}'],ARRAY['matchup_totals']);
      ${raw
          .map(
              (
                  value,
              ) => `INSERT INTO public.league_change_hints AS h(league_id,topic,revision,scopes,details,updated_at)
        VALUES('${fixture.leagueId}','${value}',1,NULL,NULL,clock_timestamp())
        ON CONFLICT(league_id,topic) DO UPDATE SET revision=h.revision+1,scopes=NULL,details=NULL,updated_at=clock_timestamp();`,
          )
          .join('\n')}
      COMMIT;
      SELECT (extract(epoch FROM updated_at)*1000)::double precision FROM public.league_change_hints WHERE league_id='${fixture.leagueId}' AND topic='version';`
    return Number(await sql(statement))
}
for (const [index, name] of cases.entries()) {
    const session = `l5cr-${label[0]}-${engine[0]}-${round}-${name}`
    const agent = async (args) =>
        (
            await exec('agent-browser', ['--session', session, ...args], {
                timeout: 60000,
                maxBuffer: 1024 * 1024,
            })
        ).stdout
    let browser, context, page, browserServer
    const pausedProcesses = []
    const row = {
        name,
        api: [],
        errors: [],
        blocked: [],
        socket: {
            opened: 0,
            joined: 0,
            closed: 0,
            serverClosed: 0,
            hints: 0,
            dropped: 0,
            heartbeatReplies: 0,
        },
        startedAt: Date.now(),
    }
    const fault = { data: false, all: false, version: false, holdClose: false }
    try {
        await sql(`BEGIN; SET LOCAL session_replication_role=replica;
          UPDATE public.nba_games SET status=CASE WHEN nba_game_id='0022609002' AND ${name !== 'quiet-idle'} THEN 'InProgress' ELSE 'Final' END WHERE game_date='${fixture.today}';
          COMMIT;`)
        const initial = 400 + Number(round) * 100 + index * 2
        const target = initial + 1
        await publish(initial)
        if (engine === 'chromium') {
            await agent([
                '--ignore-https-errors',
                '--args',
                `--host-resolver-rules=MAP ${hostname} 127.0.0.1,EXCLUDE localhost`,
                '--allowed-domains',
                `127.0.0.1,localhost,${hostname}`,
                'open',
                `${origin}/release-provenance.json`,
            ])
            const endpoint = (await agent(['get', 'cdp-url'])).match(/ws:\/\/\S+/)?.[0]
            assert.ok(endpoint)
            browser = await chromium.connectOverCDP(endpoint)
            context = browser.contexts()[0]
            page = context.pages().find((candidate) => candidate.url().startsWith(origin))
            await agent(['set', 'viewport', '390', '844'])
        } else {
            browserServer = await webkit.launchServer({ headless: true })
            browser = await webkit.connect(browserServer.wsEndpoint())
            context = await browser.newContext({
                ...devices['iPhone 13'],
                viewport: { width: 390, height: 844 },
                ignoreHTTPSErrors: true,
                serviceWorkers: 'block',
                proxy: { server: 'http://127.0.0.1:63385' },
            })
            page = await context.newPage()
            if (name === 'sleep') await page.clock.install({ time: new Date() })
        }
        await context.route('**/*', (route) => {
            const url = new URL(route.request().url())
            if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol))
                return route.continue()
            row.blocked.push(`${url.origin}${url.pathname}`)
            return route.abort()
        })
        await context.routeWebSocket(
            (url) => new URL(url).pathname.startsWith('/realtime/v1/websocket'),
            (client) => {
                const target = new URL(client.url())
                assert.equal(target.hostname, hostname)
                assert.equal(target.port, '63384')
                assert.equal(target.protocol, 'wss:')
                const server = client.connectToServer()
                let open = true
                row.socket.opened++
                server.onMessage((message) => {
                    let packet
                    try {
                        packet = JSON.parse(String(message))
                    } catch {}
                    if (Array.isArray(packet))
                        packet = { topic: packet[2], event: packet[3], payload: packet[4] }
                    if (packet?.event === 'phx_reply' && packet.payload?.status === 'ok')
                        row.socket.joined++
                    if (packet?.topic === 'phoenix' && packet.event === 'phx_reply')
                        row.socket.heartbeatReplies++
                    const hint = packet?.event === 'postgres_changes'
                    const topic = packet?.payload?.data?.record?.topic
                    if (hint) row.socket.hints++
                    if (
                        fault.all ||
                        (hint && (fault.data || (fault.version && topic === 'version')))
                    ) {
                        if (hint) row.socket.dropped++
                        return
                    }
                    client.send(message)
                })
                client.onMessage((message) => {
                    if (open && !fault.all) server.send(message)
                })
                server.onClose((code, reason) => {
                    open = false
                    row.socket.serverClosed++
                    if (!fault.holdClose)
                        void client
                            .close({ code: code === 1006 ? 1000 : code, reason })
                            .catch(() => {})
                })
                client.onClose((code, reason) => {
                    row.socket.closed++
                    if (open)
                        void server
                            .close({ code: code === 1006 ? 1000 : code, reason })
                            .catch(() => {})
                })
            },
        )
        await context.addInitScript(
            ({ session: current, key }) => {
                localStorage.setItem(key, JSON.stringify(current))
                localStorage.setItem('pancake-theme', 'light')
                window.__l5cVisibility = 'visible'
                Object.defineProperty(document, 'visibilityState', {
                    configurable: true,
                    get: () => window.__l5cVisibility,
                })
            },
            { session: login.session, key: `sb-${hostname.split('.')[0]}-auth-token` },
        )
        page.on('pageerror', (event) => row.errors.push(event.message))
        page.on('response', (response) => {
            const url = new URL(response.url())
            if (
                url.origin === origin &&
                (/\/api\/(version|views\/home)$/.test(url.pathname) ||
                    ['/rest/v1/nba_games', '/rest/v1/league_change_hints'].includes(url.pathname))
            )
                row.api.push({ path: url.pathname, status: response.status(), at: Date.now() })
        })
        const route = `${origin}/matchup?matchupId=${matchup}`
        if (engine === 'chromium') await agent(['open', route])
        else await page.goto(route, { waitUntil: 'domcontentloaded' })
        const selector = '[data-testid="other-matchup-page"] [data-testid="matchup-score-card"]'
        const waitScore = (points, timeout) =>
            page.waitForFunction(
                ({ selector: selected, text }) =>
                    document.querySelector(selected)?.textContent?.includes(text),
                { selector, text: points.toFixed(1) },
                { timeout },
            )
        await waitScore(initial, 45000)
        await page.waitForFunction(() => !document.getElementById('pancake-boot-shell'))
        await delay(1000)
        const joinedBy = Date.now() + 45000
        while (
            Date.now() < joinedBy &&
            (!row.socket.joined ||
                !row.api.some(
                    (request) =>
                        request.path.endsWith('league_change_hints') && request.status === 200,
                ))
        )
            await delay(100)
        assert.ok(row.socket.joined > 0, 'The realtime socket never joined')
        assert.ok(
            row.api.some(
                (request) => request.path.endsWith('league_change_hints') && request.status === 200,
            ),
            'The realtime baseline was not read',
        )
        row.measurementAt = Date.now()
        const screenshot = async (suffix) => {
            const file = path.join(directory, `${name}-${suffix}.png`)
            if (engine === 'chromium') await agent(['screenshot', file])
            else await page.screenshot({ path: file })
        }
        if (round === '1') await screenshot('initial')
        if (name.endsWith('-idle')) {
            await delay(60000)
            row.recovered = true
            row.idleSeconds = (Date.now() - row.measurementAt) / 1000
        } else {
            let timeout = 2000
            let publication = ['version']
            if (['score', 'stat'].includes(name)) {
                fault.version = true
                publication = [name]
            }
            if (name === 'combined') publication = ['score', 'stat']
            if (name.startsWith('silent') || name === 'realtime-restart') {
                fault.data = true
                fault.all = name === 'silent-all'
                fault.holdClose = true
                timeout = label === 'before' ? 45000 : 30000
            }
            if (name === 'realtime-restart') {
                const names = (
                    await exec('docker', [
                        'ps',
                        '--filter',
                        'label=com.supabase.cli.project=pt4bafablerq',
                        '--format',
                        '{{.Names}}',
                    ])
                ).stdout
                    .trim()
                    .split('\n')
                    .filter((value) => value.includes('realtime'))
                assert.equal(names.length, 1)
                await exec('docker', ['restart', names[0]], { timeout: 60000 })
                await delay(1000)
            }
            if (['offline', 'hidden', 'sleep'].includes(name)) fault.data = true
            if (name === 'offline') await context.setOffline(true)
            if (name === 'hidden')
                await page.evaluate(() => {
                    window.__l5cVisibility = 'hidden'
                    document.dispatchEvent(new Event('visibilitychange'))
                })
            if (name === 'sleep') {
                await page.evaluate(() => {
                    window.__l5cTicks = 0
                    window.__l5cTickTimer = window.setInterval(() => window.__l5cTicks++, 1000)
                })
                if (engine === 'webkit') {
                    await page.clock.pauseAt(new Date())
                    row.suspension = 'automation-page-clock'
                } else {
                    const session = await browser.newBrowserCDPSession()
                    const { processInfo } = await session.send('SystemInfo.getProcessInfo')
                    await session.detach()
                    const pid = processInfo.find((process) => process.type === 'browser')?.id
                    const renderers = processInfo
                        .filter((process) => process.type === 'renderer')
                        .map((process) => process.id)
                    assert.ok(Number.isInteger(pid) && pid > 1)
                    const parents = (await exec('ps', ['-axo', 'pid=,ppid='])).stdout
                        .trim()
                        .split('\n')
                        .map((line) => line.trim().split(/\s+/).map(Number))
                    const owned = new Set([pid])
                    for (let previous = 0; previous !== owned.size; ) {
                        previous = owned.size
                        for (const [child, parent] of parents)
                            if (owned.has(parent)) owned.add(child)
                    }
                    assert.ok(owned.size > 1)
                    assert.ok(renderers.every((renderer) => owned.has(renderer)))
                    for (const child of owned) {
                        process.kill(child, 'SIGSTOP')
                        pausedProcesses.push(child)
                    }
                    row.suspension = 'automation-browser-process-tree'
                    row.suspendedProcessCount = owned.size
                }
            }
            row.publishedAt = await publish(target, publication)
            if (['offline', 'hidden', 'sleep'].includes(name)) {
                await delay(name === 'offline' ? 2000 : 25000)
                row.suspendedApi = row.api.filter((request) => request.at >= row.publishedAt)
                row.resumedAt = Date.now()
                if (name === 'offline') await context.setOffline(false)
                else {
                    for (const pid of pausedProcesses.splice(0)) process.kill(pid, 'SIGCONT')
                    if (name === 'sleep' && engine === 'webkit') {
                        row.pausedTicks = await page.evaluate(() => window.__l5cTicks)
                        assert.equal(row.pausedTicks, 0)
                        await page.clock.fastForward(25000)
                        await page.clock.resume()
                    }
                    await page.evaluate(() => {
                        window.__l5cVisibility = 'visible'
                        document.dispatchEvent(new Event('visibilitychange'))
                        window.dispatchEvent(new Event('pageshow'))
                        window.dispatchEvent(new Event('focus'))
                    })
                    if (name === 'sleep') {
                        row.suspendedTicks = await page.evaluate(() => {
                            clearInterval(window.__l5cTickTimer)
                            return window.__l5cTicks
                        })
                        assert.ok(
                            row.suspendedTicks <= 2,
                            'The automation browser kept running during suspension',
                        )
                        assert.equal(
                            row.suspendedApi.length,
                            0,
                            'The suspended browser made an API request',
                        )
                    }
                }
                timeout = label === 'before' ? 5000 : 2000
            }
            row.recovered = await waitScore(target, timeout).then(
                () => true,
                () => false,
            )
            row.elapsedMs = Date.now() - (row.resumedAt ?? row.publishedAt)
            row.expectedScore = target
            row.visibleScore = await page.locator(selector).innerText()
            if (round === '1') await screenshot('result')
        }
        row.measuredApi = row.api.filter((request) => request.at >= row.measurementAt)
        row.socketAtEnd = { ...row.socket }
        row.versionRequests = row.measuredApi.filter((request) =>
            request.path.endsWith('/version'),
        ).length
        row.viewRequests = row.measuredApi.filter((request) =>
            request.path.endsWith('/views/home'),
        ).length
        console.log(
            `${label}/${engine}/${round} ${name}: recovered=${row.recovered} ms=${row.elapsedMs ?? 0} versions=${row.versionRequests} views=${row.viewRequests} dropped=${row.socket.dropped}`,
        )
        assert.deepEqual(row.errors, [])
        assert.ok(!row.measuredApi.some((request) => request.status >= 400))
        if (label === 'after')
            assert.equal(row.recovered, true, `${name} did not recover inside its deadline`)
    } catch (failure) {
        row.error = failure.message
        console.error(`${name}: ${failure.message}`)
    } finally {
        for (const pid of pausedProcesses) {
            try {
                process.kill(pid, 'SIGCONT')
            } catch {}
        }
        row.finishedAt = Date.now()
        report.rows.push(row)
        await save()
        if (engine === 'webkit') await context?.close().catch(() => {})
        await browser?.close().catch(() => {})
        await browserServer?.close().catch(() => {})
        if (engine === 'chromium') await agent(['close']).catch(() => {})
    }
}
report.finishedAt = new Date().toISOString()
await save()
for (const socket of tunnels) socket.destroy()
if (proxy) await new Promise((resolve) => proxy.close(resolve))
assert.ok(
    report.rows.every((row) => !row.error),
    'Recovery capture has errors',
)
