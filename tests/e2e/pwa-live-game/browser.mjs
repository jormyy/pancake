import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { trafficProxy } from './traffic-proxy.mjs'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

const hash = value => createHash('sha256').update(value).digest('hex')
const cleanEndpoint = value => new URL(value).pathname.replace(/-[a-f0-9]{32}\.js$/, '-HASH.js')

export async function originProxy(port, upstream, requests, manager, expectedHost) {
    const sockets = new Set()
    const server = http.createServer((request, response) => {
        if (expectedHost && request.headers.host !== expectedHost) { response.writeHead(403); response.end(); return }
        const at = Date.now()
        const target = http.request({ hostname: '127.0.0.1', port: upstream, path: request.url, method: request.method, headers: request.headers }, incoming => {
            const chunks = []
            response.writeHead(Number(incoming.statusCode ?? 502), incoming.headers)
            incoming.on('data', bytes => { chunks.push(bytes); response.write(bytes) })
            incoming.on('end', () => {
                const bytes = Buffer.concat(chunks)
                const encoding = incoming.headers['content-encoding']
                const decoded = encoding === 'br' ? brotliDecompressSync(bytes) : encoding === 'gzip' ? gunzipSync(bytes) : bytes
                requests.push({ at, manager, endpoint: cleanEndpoint(`http://127.0.0.1:${port}${request.url}`), target: 'web', method: request.method,
                    signature: hash(`${request.method} ${request.url}`), transfer: bytes.length + incoming.rawHeaders.join('\r\n').length + 17, decoded: decoded.length, status: incoming.statusCode })
                response.end()
            })
        })
        target.on('error', () => { response.writeHead(502); response.end() })
        request.pipe(target)
    })
    server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)) })
    await new Promise(resolve => server.listen(Number(port), '127.0.0.1', () => resolve(undefined)))
    return async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) }
}

function installObserver(session) {
    if (!localStorage.getItem('sb-127-auth-token')) localStorage.setItem('sb-127-auth-token', JSON.stringify(session))
    window['__pwaMeasure'] = { longTasks: [], scores: [] }
    new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window['__pwaMeasure'].longTasks.push({ at: performance.timeOrigin + entry.startTime, start: entry.startTime, duration: entry.duration })
    }).observe({ type: 'longtask', buffered: true })
    let previous = ''
    let queued = false
    const observe = () => {
        if (queued) return
        queued = true
        requestAnimationFrame(() => {
            queued = false
            const node = document.querySelector('[data-testid="matchup-score-card"]')
            const scores = [...(node?.children[2]?.children ?? [])].map(child => child.textContent).join('\n')
            if (scores && previous !== scores) {
                previous = scores
                window['__pwaMeasure'].scores.push({ at: Date.now(), text: scores })
            }
        })
    }
    new MutationObserver(observe).observe(document, { childList: true, subtree: true, characterData: true })
    document.addEventListener('DOMContentLoaded', observe, { once: true })
}

export async function openManager(browser, origin, manager, session, phone, requests) {
    const context = browser.contexts()[0]
    const page = await context.newPage()
    await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1440, height: 900 })
    await page.addInitScript(installObserver, session)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp.send('Network.enable')
    await cdp.send('Network.setBlockedURLs', { urls: ['https://*', 'wss://*', '*ceeytbfmwsnzalxlkalc*', '*.supabase.co/*', '*vercel.app/*'] })
    await cdp.send('Performance.enable')
    if (phone) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 200000, connectionType: 'cellular3g' })
    const pending = new Map()
    const streams = new Map()
    cdp.on('Network.webSocketCreated', event => {
        const row = { at: Date.now(), manager, endpoint: cleanEndpoint(event.url), target: 'supabase', method: 'WS', signature: hash(event.url), transfer: 0, decoded: 0 }
        streams.set(event.requestId, row)
        requests.push(row)
    })
    cdp.on('Network.webSocketFrameReceived', event => {
        const row = streams.get(event.requestId)
        if (row) row.decoded += event.response.opcode === 2 ? Buffer.from(event.response.payloadData, 'base64').length : Buffer.byteLength(event.response.payloadData)
    })
    cdp.on('Network.requestWillBeSent', event => {
        const url = new URL(event.request.url)
        if (!['http:', 'https:'].includes(url.protocol)) return
        if (url.port === new URL(origin).port) return
        pending.set(event.requestId, { at: Date.now(), manager, endpoint: cleanEndpoint(url), target: 'supabase', method: event.request.method,
            signature: hash(`${event.request.method} ${url.href} ${event.request.postData ?? ''}`), transfer: 0, decoded: 0 })
    })
    cdp.on('Network.responseReceived', event => { const row = pending.get(event.requestId); if (row) row.status = event.response.status })
    cdp.on('Network.dataReceived', event => { const row = pending.get(event.requestId); if (row) row.decoded += event.dataLength })
    cdp.on('Network.loadingFinished', event => {
        const row = pending.get(event.requestId)
        if (row) { row.transfer = event.encodedDataLength; requests.push(row); pending.delete(event.requestId) }
    })
    cdp.on('Network.loadingFailed', event => { const row = pending.get(event.requestId); if (row) { requests.push({ ...row, failure: event.errorText }); pending.delete(event.requestId) } })
    const sample = async () => {
        const [heap, metrics, observer] = await Promise.all([
            cdp.send('Runtime.getHeapUsage'), cdp.send('Performance.getMetrics'), page.evaluate(() => window['__pwaMeasure']),
        ])
        return { at: Date.now(), heap: heap.usedSize, metrics: Object.fromEntries(metrics.metrics.map(metric => [metric.name, metric.value])), ...observer }
    }
    try {
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90000 })
        await page.getByTestId('matchup-score-card').waitFor({ timeout: 60000 })
        await page.getByTestId('matchup-daily-total').waitFor({ timeout: 60000 })
    } catch (error) {
        await writeFile(`/tmp/fable-c1/open-manager-${new URL(origin).port}.json`, JSON.stringify({ errors, body: await page.locator('body').innerText() }))
        await page.close()
        throw error
    }
    return { page, cdp, sample, errors, manager, origin, close: () => page.close() }
}

async function navigate(manager, route) {
    if (new URL(manager.page.url()).pathname === route) return
    const href = route.split('?')[0]
    const links = manager.page.locator(`a[href="${href}"]:visible`)
    if (await links.count()) await links.first().click()
    else {
        const label = route === '/' ? 'Matchup' : route.slice(1).replace(/^./, letter => letter.toUpperCase())
        await manager.page.getByRole('button', { name: label, exact: true }).first().click()
    }
    if (route === '/') await manager.page.getByTestId('matchup-score-card').waitFor({ timeout: 45000 })
    else if (route === '/roster') await manager.page.getByRole('heading', { name: 'Roster', exact: true }).first().waitFor({ timeout: 45000 })
    else if (route.startsWith('/league')) await manager.page.getByRole('tab', { name: 'Standings', exact: true }).waitFor({ timeout: 45000 })
    await manager.page.waitForTimeout(1200)
}

export async function regions(manager) {
    await navigate(manager, '/')
    const score = await manager.page.getByTestId('matchup-score-card').innerText()
    await navigate(manager, '/roster')
    const roster = await manager.page.locator('body').innerText()
    await navigate(manager, '/league')
    await manager.page.getByRole('tab', { name: 'Standings', exact: true }).click()
    await manager.page.locator('#league-standings-results').waitFor({ timeout: 45000 })
    await manager.page.waitForTimeout(1200)
    const standings = await manager.page.locator('#league-standings-results').innerText()
    await navigate(manager, '/')
    assert.ok(score && roster && standings)
    return { score, roster, standings }
}

export const tabTour = [
    { route: '/roster', region: 'roster' },
    ...['Show player search', 'Waivers', 'Rankings', 'News'].map(tab => ({ route: '/players', tab })),
    ...['Offers', 'Block', 'History', 'Analyzer'].map(tab => ({ route: '/trades', tab })),
    ...['Standings', 'Activity', 'Picks', 'Schedule', 'Draft', 'Bracket', 'Settings'].map(tab => ({ route: '/league', tab, region: tab === 'Standings' ? 'standings' : undefined })),
    { route: '/', region: 'score' },
]

export async function tourStep(manager, step) {
    await navigate(manager, step.route)
    if (step.tab) {
        const tab = manager.page.getByRole('tab', { name: new RegExp(`^${step.tab}(?:, \\d+)?$`) })
        await tab.click()
        await manager.page.waitForTimeout(1200)
        if (step.tab === 'Bracket') assert.equal(new URL(manager.page.url()).pathname, '/bracket')
        else assert.equal(await tab.getAttribute('aria-selected'), 'true')
    }
    if (step.region === 'roster') return manager.page.locator('body').innerText()
    if (step.region === 'standings') return manager.page.locator('#league-standings-results').innerText()
    if (step.region === 'score') return manager.page.getByTestId('matchup-score-card').innerText()
    return null
}

export async function visibility(manager, hidden) {
    await manager.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: !hidden })
    await manager.page.waitForFunction(value => document.visibilityState === value, hidden ? 'hidden' : 'visible', { timeout: 5000 })
    assert.equal(await manager.page.evaluate(() => document.visibilityState), hidden ? 'hidden' : 'visible')
}

export async function automationBrowser(directory) {
    const profile = path.join(directory, 'automation-browser-profile')
    await mkdir(profile, { recursive: true })
    const closeProxy = await trafficProxy(path.join(directory, 'evidence'))
    const child = spawn(chromium.executablePath(), ['--headless=new', '--enable-automation', '--password-store=basic', '--use-mock-keychain', '--disable-search-engine-choice-screen', '--disable-extensions', '--disable-component-extensions-with-background-pages', '--disable-default-apps', '--disable-infobars', '--allow-pre-commit-input', '--disable-dev-shm-usage', '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults,PrivateNetworkAccessSendPreflights,HttpsUpgrades', '--proxy-server=http://127.0.0.1:64988', '--proxy-bypass-list=<-loopback>', '--remote-debugging-port=64989', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-component-update', 'about:blank'], { stdio: 'ignore' })
    let browser
    const close = async () => {
        await browser?.close()
        if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise(resolve => child.once('exit', resolve))
            child.kill('SIGTERM')
            const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
            await exited
            clearTimeout(timer)
        }
        await closeProxy()
        await mkdir(path.join(directory, 'old'), { recursive: true })
        await rename(profile, path.join(directory, 'old', `automation-browser-profile-${Date.now()}`))
    }
    try {
        for (let attempt = 0; attempt < 60; attempt++) {
            if (await fetch('http://127.0.0.1:64989/json/version').then(response => response.ok).catch(() => false)) {
                browser = await chromium.connectOverCDP('http://127.0.0.1:64989', { noDefaults: true })
                return { browser, close }
            }
            await new Promise(resolve => setTimeout(resolve, 250))
        }
        throw new Error('The separate automation browser did not start')
    } catch (error) { await close(); throw error }
}
