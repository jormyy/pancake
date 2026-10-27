import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { prepareSweepFixtures, sweepSurfaces } from '../e2e/layout-stability-fixtures.mjs'
import { requireSweepStack, resolveSweepPorts, stackEnvironment } from '../e2e/layout-stability-ports.mjs'
import { runWithScenarioResourceOwner } from '../e2e/scenario-resource-owner.mjs'
import { openWebTarget, WEB_TARGETS, waitForWebTargetReads } from '../e2e/web-targets-browser.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.slice(2).split(/=(.*)/s).slice(0, 2)))
assert.ok(args.output && args.state && args.env)
const env = await stackEnvironment(args.env)
const ports = resolveSweepPorts({ 'api-port': '59721', 'db-port': '59722', 'frontend-port': '59790' }, env)
requireSweepStack(env, ports)
const output = path.resolve(args.output)
assert.ok(!output.startsWith(`${process.cwd()}/`))
await mkdir(output, { recursive: true })
const report = { label: args.label, cells: [], limitations: ['WebKit automation with simulated standalone mode', 'Text scales once after fonts load; viewport resize and settling let virtualized rows remeasure', 'External resources and service workers are blocked', 'Geometry covers rendered nodes; virtualized offscreen rows need separate interaction checks'] }
let saving = Promise.resolve()
const save = () => {
    const body = JSON.stringify(report, null, 2)
    saving = saving.then(() => writeFile(path.join(output, 'report.json'), body))
    return saving
}

await runWithScenarioResourceOwner('design capture', async resourceOwner => {
    const fixture = await prepareSweepFixtures({ env, statePath: args.state, resourceOwner, ports })
    const surfaces = [...sweepSurfaces(fixture), { id: 'notification-settings', route: '/notification-settings', auth: true }]
        .filter(surface => !args.surfaces || args.surfaces.split(',').includes(surface.id))
    if (args.frontend) assert.equal(args.frontend, 'http://127.0.0.1:59791')
    const builds = [{ id: args.label ?? 'capture', frontend: args.frontend ?? env.E2E_FRONTEND_URL, port: args.frontend ? '59791' : ports.frontend }]
    if (args.compare) {
        assert.equal(args.compare, 'http://127.0.0.1:59791')
        builds.push({ id: 'after', frontend: args.compare, port: '59791' })
    }
    report.releases = []
    for (const build of builds) {
    const release = await fetch(`${build.frontend}/release-provenance.json`).then(response => response.json())
    report.releases.push({ label: build.id, commitSha: release.commitSha, bundleDigest: release.bundleDigest })
    report.expectedCells = surfaces.length * 4 * builds.length
    const targetBase = WEB_TARGETS.find(target => target.id === 'iphone-webkit-390-standalone')
    await Promise.all([390, 360].flatMap(width => [1, 1.3].map(async textScale => {
        const target = { ...targetBase, viewport: { width, height: 844 } }
        const directory = path.join(output, build.id, `${width}-scale-${textScale}`)
        await mkdir(directory, { recursive: true })
        for (const surface of surfaces) {
            const storage = surface.auth ? [
                { name: `sb-${new URL(env.E2E_SUPABASE_URL).hostname.split('.')[0]}-auth-token`, value: JSON.stringify(await fixture.sessionForBrowser()) },
                { name: `pancake:selected-league:v1:${fixture.me.user_id}`, value: JSON.stringify({ version: 1, savedAt: Date.now(), value: surface.empty ? fixture.empty.members[0].id : fixture.me.id }) },
            ] : []
            const client = await openWebTarget(target, directory, { serviceWorkers: 'block', storageState: { cookies: [], origins: [{ origin: build.frontend, localStorage: storage }] } })
            const row = { build: build.id, surface: surface.id, width, textScale, errors: [], route: surface.route }
            try {
                client.page.setDefaultTimeout(10000)
                client.page.setDefaultNavigationTimeout(20000)
                client.page.on('pageerror', error => row.errors.push(error.message))
                await client.context.route('**/*', route => {
                    const url = new URL(route.request().url())
                    return url.hostname === '127.0.0.1' && [String(ports.api), String(build.port)].includes(url.port) ? route.continue() : route.abort()
                })
                await client.page.goto(new URL(surface.route, build.frontend).href)
                await client.page.waitForFunction(() => !document.querySelector('#pancake-boot-shell[data-visible="1"]'))
                await waitForWebTargetReads(client.page)
                await client.page.waitForFunction(() => document.body.innerText.trim().length > 20)
                if (surface.expected && surface.id !== 'home-empty') {
                    const main = client.page.locator('[role="main"]')
                    const content = await main.count() ? main : client.page.locator('body')
                    await content.getByText(surface.expected, { exact: false }).first().waitFor({ state: 'visible' })
                }
                await client.page.evaluate(() => document.fonts.ready)
                if (textScale !== 1) {
                    await client.page.evaluate(scale => {
                        const sizes = [...document.querySelectorAll('body *')].map(element => ({ element, font: parseFloat(getComputedStyle(element).fontSize), line: parseFloat(getComputedStyle(element).lineHeight), icon: /material|ionicons/i.test(getComputedStyle(element).fontFamily) }))
                        for (const { element, font, line, icon } of sizes) {
                            if (icon) continue
                            element.style.fontSize = `${font * scale}px`
                            if (Number.isFinite(line)) element.style.lineHeight = `${line * scale}px`
                        }
                    }, textScale)
                    await client.page.setViewportSize({ width: width + 1, height: 844 })
                    await client.page.setViewportSize({ width, height: 844 })
                }
                await client.page.waitForTimeout(750)
                row.geometry = await client.page.evaluate(textScale => {
                    const visible = element => {
                        const box = element.getBoundingClientRect()
                        return box.width > 1 && box.height > 1 && getComputedStyle(element).visibility === 'visible' && !element.closest('[inert],[aria-hidden="true"]')
                    }
                    const controls = [...document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[role="tab"],[role="switch"]')].filter(visible)
                    const targets = controls.map(element => {
                        const box = element.getBoundingClientRect()
                        return { label: element.getAttribute('aria-label') ?? element.textContent, x: box.x, y: box.y, width: box.width, height: box.height }
                    })
                    const overlaps = controls.flatMap((a, index) => controls.slice(index + 1).filter(b => {
                        if (a.contains(b) || b.contains(a)) return false
                        const x = a.getBoundingClientRect(), y = b.getBoundingClientRect()
                        if (x.bottom <= 0 || y.bottom <= 0 || x.top >= innerHeight || y.top >= innerHeight || x.right <= 0 || y.right <= 0 || x.left >= innerWidth || y.left >= innerWidth) return false
                        return Math.min(x.right, y.right) - Math.max(x.left, y.left) > 0.5 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 0.5
                    }).map(b => [a.getAttribute('aria-label') ?? a.textContent, b.getAttribute('aria-label') ?? b.textContent]))
                    const clipped = [...document.querySelectorAll('[dir="auto"]')].filter(visible)
                        .filter(element => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
                        .map(element => ({ text: element.textContent, width: element.clientWidth, height: element.clientHeight, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight }))
                    const main = document.querySelector('[role="main"]') ?? document.body
                    const header = document.querySelector('[aria-label="Close lineup"]')?.parentElement?.parentElement
                    const headerFonts = [...document.querySelectorAll('[data-testid^="page-header-"]')].filter(visible).flatMap(header => [...header.querySelectorAll('[dir="auto"]')].filter(element => visible(element) && /Outfit_700Bold/.test(getComputedStyle(element).fontFamily) && !element.closest('[role="button"],[role="tab"]')).slice(0, 1).map(element => ({ title: element.textContent, actual: parseFloat(getComputedStyle(element).fontSize), expected: (header.getAttribute('data-testid') === 'page-header-compact' ? 16 : 18) * textScale })))
                    const overflowNodes = [...document.querySelectorAll('body *')].filter(visible).filter(element => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(element => ({ tag: element.tagName, text: element.textContent.slice(0, 70), width: element.getBoundingClientRect().width }))
                    return { text: main.innerText, headerFonts, overflowNodes, targets, small: targets.filter(box => box.width < 43.9 || box.height < 43.9), clipped, overlaps, overflow: document.documentElement.scrollWidth > innerWidth, lineupHeaderHeight: header?.getBoundingClientRect().height }
                }, textScale)
                row.screenshot = `${build.id}/${width}-scale-${textScale}/${surface.id}.png`
                await client.page.screenshot({ path: path.join(output, row.screenshot) })
                row.pass = !row.errors.length && !row.geometry.small.length && !row.geometry.clipped.length && !row.geometry.overlaps.length && !row.geometry.overflow && row.geometry.headerFonts.every(font => Math.abs(font.actual - font.expected) < 0.2)
            } catch (error) {
                row.pass = false
                row.error = error.message
                await client.page.screenshot({ path: path.join(directory, `${surface.id}-error.png`) }).catch(() => {})
            } finally {
                await client.context.close()
                await client.browser.close()
                report.cells.push(row)
                await save()
                process.stdout.write(`${build.id} ${surface.id} ${width} ${textScale}: ${row.pass ? 'pass' : 'fail'}${row.error ? ` ${row.error}` : ''}\n`)
            }
        }
    })))
    }
})
if (args.compare) {
    report.comparison = report.cells.filter(row => row.build === 'after').map(after => {
        const before = report.cells.find(row => row.build !== 'after' && row.surface === after.surface && row.width === after.width && row.textScale === after.textScale)
        const labels = row => (row?.geometry?.targets ?? []).map(target => String(target.label ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean)
        const afterLabels = new Set(labels(after))
        return { surface: after.surface, width: after.width, textScale: after.textScale, missingLabels: labels(before).filter(label => !afterLabels.has(label)), beforePass: before?.pass, afterPass: after.pass }
    })
}
await save()
const accepted = args.compare ? report.cells.filter(row => row.build === 'after') : report.cells
process.exitCode = report.cells.length === report.expectedCells && accepted.every(row => row.pass) ? 0 : 1
