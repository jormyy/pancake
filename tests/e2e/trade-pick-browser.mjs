import { webkit, devices } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

export function isLocalTradePickUrl(value) {
        const url = new URL(value)
        return ['data:', 'blob:'].includes(url.protocol) || ['127.0.0.1', 'localhost'].includes(url.hostname)
}

async function runTradePickBrowser(output, stage = 'before', state = 'pending') {
    assert.ok(output)
    await mkdir(output, { recursive: true })
    const browser = await webkit.launch({ headless: true })
    const tradeId = 'b4c1dea6-e389-45aa-bedf-a26e12f46d38'
    const evidence = []
    try {
        for (const viewer of [
            { name: 'proposer', id: 'e8220878-af71-47e1-883e-46251bea6057', from: "Mike's Minions", to: 'You' },
            { name: 'recipient', id: '9fe20af7-b2fb-4ab6-bd42-2e2e7ccc5dd9', from: 'You', to: 'Matthew' },
        ]) {
            const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } })
            await context.route('**/*', route => {
                return isLocalTradePickUrl(route.request().url()) ? route.continue() : route.abort()
            })
            const page = await context.newPage()
            const errors = []
            page.on('pageerror', error => errors.push(error.message))
            await page.goto('http://127.0.0.1:59680/trades', { waitUntil: 'networkidle' })
            await page.getByPlaceholder('you@example.com').fill(`${viewer.id}@example.test`)
            await page.getByPlaceholder('Your password').fill('Fable-picks-local-2026')
            await page.getByRole('button', { name: 'Sign In', exact: true }).click()
            await page.waitForURL('http://127.0.0.1:59680/', { timeout: 30000 })
            await page.getByText('Browse Players', { exact: true }).waitFor({ timeout: 30000 })
            await page.goto('http://127.0.0.1:59680/trades', { waitUntil: 'networkidle' })
            if (state === 'history') await page.getByRole('tab', { name: /^History/ }).click()
            const card = page.locator(`#trade-details-${tradeId}`)
            await card.waitFor({ state: 'visible', timeout: 30000 })
            await card.scrollIntoViewIfNeeded()
            const expected = [
                `2029 Round 1 (orig. Mike's Minions) — from ${viewer.from} → to ${viewer.to}`,
                `2028 Round 2 (orig. Mike's Minions) — from ${viewer.from} → to ${viewer.to}`,
            ]
            const cardText = await card.innerText()
            if (stage === 'after') for (const label of expected) assert.ok(cardText.includes(label), label)
            await page.screenshot({ path: `${output}/${state}-${viewer.name}.png` })
            await card.click()
            await page.waitForTimeout(1500)
            const details = await page.locator('body').innerText()
            if (stage === 'after') for (const label of expected) assert.ok(details.includes(label), label)
            await page.screenshot({ path: `${output}/review-${state}-${viewer.name}.png` })
            assert.equal(await page.evaluate(() => window.innerWidth), 390)
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
            let submitted = null
            if (viewer.name === 'proposer' && state === 'pending') {
                await page.getByRole('button', { name: "Edit trade with Mike's Minions", exact: true }).last().click()
                await page.waitForTimeout(3000)
                await page.getByRole('button', { name: 'Review trade proposal', exact: true }).last().click({ timeout: 30000 })
                await page.getByRole('button', { name: 'Edit assets', exact: true }).waitFor()
                submitted = await page.locator('body').innerText()
                if (stage === 'after') for (const label of expected) assert.ok(submitted.includes(label), label)
                await page.screenshot({ path: `${output}/submitted-${viewer.name}.png` })
            }
            let activity = null
            if (state === 'history') {
                await page.goto('http://127.0.0.1:59680/league?tab=activity', { waitUntil: 'networkidle' })
                await page.getByText(expected[0], { exact: true }).waitFor({ timeout: 30000 })
                activity = await page.locator('body').innerText()
                for (const label of expected) assert.ok(activity.includes(label), label)
                await page.getByText(expected[0], { exact: true }).scrollIntoViewIfNeeded()
                await page.screenshot({ path: `${output}/activity-${viewer.name}.png` })
            }
            evidence.push({ state, viewer: viewer.name, cardText, details, submitted, activity, errors })
            assert.deepEqual(errors, [])
            await context.close()
        }
        await writeFile(`${output}/${state}.json`, JSON.stringify(evidence, null, 2))
        console.log(JSON.stringify(evidence.map(({ viewer, cardText, errors }) => ({ viewer, cardText, errors }))))
    } finally {
        await browser.close()
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
        const [output, stage, state] = process.argv.slice(2)
        await runTradePickBrowser(output, stage, state)
}
