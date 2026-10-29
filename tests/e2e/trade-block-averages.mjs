import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

export function assertListingAverages(comparisons) {
    assert.ok(comparisons.length > 0, 'The screen must contain player averages')
    for (const comparison of comparisons) assert.equal(comparison.actual, comparison.expected, comparison.player)
}

async function run(args) {
    const url = new URL('/trades?tab=block', args.url)
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Use a private local frontend')
    assert.ok(args.state && args.output, 'Provide --state and --output')
    const storageState = JSON.parse(await readFile(args.state, 'utf8'))
    await mkdir(args.output, { recursive: true })
    const browser = await chromium.launch()
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState, serviceWorkers: 'block' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await context.route('**/*', route => {
        const target = new URL(route.request().url())
        return ['127.0.0.1', 'localhost'].includes(target.hostname) || ['data:', 'blob:'].includes(target.protocol)
            ? route.continue() : route.abort('blockedbyclient')
    })
    try {
        const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/views/trade-block'))
        await page.goto(url.href)
        const response = await responsePromise
        assert.equal(response.status(), 200)
        const { view } = await response.json()
        const players = view.items.filter(item => item.asset.kind === 'player' && item.asset.avgFantasyPoints > 0 && item.asset.avgMinutesPlayed > 0)
        assert.ok(players.length > 0, 'The fixture must list players with current-season averages')
        const comparisons = []
        for (const { asset } of players) {
            const row = page.getByTestId('player-row-content').filter({ has: page.getByText(asset.playerName, { exact: true }) }).first()
            await row.waitFor()
            const actual = await row.getByTestId('player-stats-line').innerText()
            const expected = `${asset.avgFantasyPoints.toFixed(1)} FP · ${asset.avgMinutesPlayed.toFixed(1)} mins`
            comparisons.push({ player: asset.playerName, expected, actual })
        }
        const geometry = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth }))
        await page.screenshot({ path: path.join(args.output, 'trade-block-390.png') })
        await writeFile(path.join(args.output, 'trade-block.json'), JSON.stringify({ route: response.url(), geometry, comparisons, errors }, null, 2))
        assertListingAverages(comparisons)
        assert.deepEqual(geometry, { width: 390, overflow: false })
        assert.deepEqual(errors, [])
        console.log(`PASS: ${comparisons.length} listings match the view at 390 px`)
    } finally {
        await context.close()
        await browser.close()
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    await run(Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2))))
}
