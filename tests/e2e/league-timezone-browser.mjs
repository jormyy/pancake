import { fileURLToPath } from 'node:url'
import path from 'node:path'
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

export function assertLeagueTimeBrowserTarget(value) {
    const url = new URL(value)
    assert.equal(url.protocol, 'http:')
    assert.equal(url.host, '127.0.0.1:58080')
    return url.origin
}

async function main() {
const base = assertLeagueTimeBrowserTarget(process.env.E2E_FRONTEND_URL)
const evidence = process.env.LEAGUE_TIME_EVIDENCE
assert(evidence)
const state = JSON.parse(await readFile('tests/e2e-state.json', 'utf8'))
await mkdir(evidence, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Tokyo' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => {
        const url = new URL(route.request().url())
        if (!['127.0.0.1', 'localhost'].includes(url.hostname) && !['data:', 'blob:'].includes(url.protocol)) return route.abort()
        if (url.pathname.includes('/headshot/')) return route.fulfill({ status: 404, body: '' })
        return route.continue()
    })
    await page.goto(`${base}/sign-in`)
    await page.locator('#pancake-auth-document').waitFor({ state: 'detached' })
    const email = page.getByPlaceholder('you@example.com', { exact: true })
    const password = page.getByPlaceholder('Your password', { exact: true })
    await email.pressSequentially(state.users[0].email, { delay: 20 })
    await password.pressSequentially(state.password, { delay: 20 })
    await password.press('Tab')
    await page.getByRole('button', { name: 'Sign In', exact: true }).click()
    await page.waitForURL(url => !url.pathname.includes('sign-in'), { timeout: 30_000 }).catch(async error => { console.log((await page.locator('body').innerText()).slice(0, 2500)); console.log(errors); throw error })
    await page.goto(`${base}/commissioner-settings`)
    const input = page.getByRole('textbox', { name: 'League timezone', exact: true })
    await input.waitFor({ timeout: 30_000 })
    assert.equal(await input.inputValue(), 'America/Los_Angeles')
    await page.getByText('Waiver runs occur at local midnight. All times and day boundaries follow this timezone.', { exact: true }).waitFor()
    await input.fill('Asia/Tokyo')
    await page.getByRole('button', { name: 'Save league settings', exact: true }).click()
    await page.waitForURL(url => !url.pathname.includes('commissioner-settings'), { timeout: 30_000 })
    await page.goto(`${base}/commissioner-settings`)
    await input.waitFor({ timeout: 30_000 })
    assert.equal(await input.inputValue(), 'Asia/Tokyo')
    await input.fill('America/Los_Angeles')
    await page.getByRole('button', { name: 'Save league settings', exact: true }).click()
    await page.waitForURL(url => !url.pathname.includes('commissioner-settings'), { timeout: 30_000 })
    await page.goto(`${base}/players?section=waivers`)
    await page.getByText(/Next run .*12:00 AM PT/).waitFor({ timeout: 30_000 })
    assert.equal(await page.getByText(/3 AM ET/).count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: `${evidence}/waivers-pacific.png`, fullPage: true })
    assert.deepEqual(errors, [])
    const checks = ['Timezone note', 'Save Tokyo timezone', 'Reload saved timezone', 'Restore Pacific timezone', 'Midnight PT label from Tokyo browser', 'Mobile width', 'No page errors']
    await writeFile(`${evidence}/browser.json`, JSON.stringify({ checks, passed: checks.length }, null, 2))
    console.log(`PASS: ${checks.length} browser checks`)
} finally {
    await browser.close()
}

}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main()
