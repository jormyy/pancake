import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const evidence = process.env.TIMELINE_EVIDENCE
if (!evidence) throw new Error('TIMELINE_EVIDENCE is required.')
await mkdir(evidence, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('http://127.0.0.1:59931/tests/lib/timeline/browser/')
    await page.getByText('Bid tied; the other team has priority.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Claims', exact: true }).click()
    if (await page.getByText('Trade executed', { exact: true }).count()) throw new Error('Claims filter includes a trade.')
    await page.getByRole('button', { name: 'Load older activity', exact: true }).click()
    await page.getByText('Waiver claim awarded', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Trades', exact: true }).click()
    await page.getByText('The other manager sent a counteroffer.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'All', exact: true }).click()
    await page.getByText('Lineup auto-set', { exact: true }).waitFor()
    await page.getByText('Matchup scores finalized', { exact: true }).waitFor()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    if (overflow) throw new Error('Timeline exceeds the mobile viewport.')
    if (errors.length) throw new Error(errors.join('\n'))
    await page.screenshot({ path: path.join(evidence, 'timeline-mobile.png'), fullPage: true })
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.screenshot({ path: path.join(evidence, 'timeline-desktop.png'), fullPage: true })
    console.log('PASS: recorded reasons, claims/trades filters, older activity, lineup/score rows, mobile width, browser errors')
} finally {
    await browser.close()
}
