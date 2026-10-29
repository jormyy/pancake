import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { webkit } from 'playwright'

export function assertOfferStable(initial, samples, buttonCount = 2) {
    assert.equal(initial.buttons.length, buttonCount)
    assert.deepEqual(initial.summary, ['Every kingdom needs its Castle: 21/20 · IR 1/2 · Taxi 3/3', 'Matthew: 20/20 · IR 2/2 · Taxi 3/3'])
    for (const { at: _at, ...sample } of samples) {
        const { at: _initialAt, ...expected } = initial
        assert.deepEqual(sample, expected, 'Offer buttons and roster summary must stay stable during all refreshes')
    }
}

async function runTradeOfferStability() {
const phase = process.argv.includes('--before') ? 'before' : 'after'
const output = process.env.E2E_BROWSER_ARTIFACT_DIR
assert.ok(output, 'E2E_BROWSER_ARTIFACT_DIR is required')
await mkdir(output, { recursive: true })
const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
assert.equal(status.API_URL, 'http://127.0.0.1:59921')
assert.equal(new URL(status.DB_URL).port, '59922')
const frontend = 'http://127.0.0.1:59980'
const league = 'faab8d8f-6a60-4bbc-8f5d-44050b652cdd'
const member = 'f88efcab-64d5-4d03-a181-4e6dd54eb1cd'
const trade = '8bb264f6-952f-4eea-96c6-3908eb6b178a'
const sql = query => execFileSync('psql', [status.DB_URL, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: query, encoding: 'utf8' }).trim()
sql(await readFile(new URL('./trade-offer-stability-fixture.sql', import.meta.url), 'utf8'))
const user = sql(`SELECT user_id FROM public.league_members WHERE id='${member}'`)
const auth = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false } })
const { data, error } = await auth.auth.signInWithPassword({ email: `${user}@offer.test`, password: 'LocalOffer123!' })
assert.ifError(error)
assert.ok(data.session)
const storageState = { cookies: [], origins: [{ origin: frontend, localStorage: [
    { name: 'sb-127-auth-token', value: JSON.stringify(data.session) },
    { name: `pancake:selected-league:v1:${user}`, value: JSON.stringify({ version: 1, savedAt: Date.now(), value: member }) },
] }] }
await writeFile(`${output}/local-state.json`, JSON.stringify(storageState), { mode: 0o600 })
if (process.argv.includes('--prepare')) process.exit(0)
const browser = await webkit.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, storageState, reducedMotion: 'reduce' })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
let tradeReads = 0
let previewReads = 0
await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.protocol !== 'data:' && (url.hostname !== '127.0.0.1' || !['59921', '59980', '59981'].includes(url.port))) return route.abort()
    if (url.pathname.endsWith('/views/trades')) { tradeReads++; await new Promise(resolve => setTimeout(resolve, 350)) }
    if (url.pathname.endsWith('/roster-preview')) { previewReads++; await new Promise(resolve => setTimeout(resolve, 350)) }
    if (url.pathname.startsWith('/functions/v1/api/')) { url.port = '59981'; return route.continue({ url: url.href }) }
    return route.continue()
})
try {
    await page.goto(`${frontend}/trades`)
    await page.getByTestId(`trade-details-${trade}`).click()
    await page.getByText('Matthew: 20/20 · IR 2/2 · Taxi 3/3', { exact: true }).filter({ visible: true }).waitFor()
    await page.getByText('Every kingdom needs its Castle: 21/20 · IR 1/2 · Taxi 3/3', { exact: true }).filter({ visible: true }).waitFor()
    await page.waitForTimeout(1000)
    await page.screenshot({ path: `${output}/${phase}-settled.png`, fullPage: true })
    const watch = async buttonName => page.evaluate(buttonName => {
        const capture = () => ({
            buttons: [...document.querySelectorAll('[role="button"]')].filter(node => node.getAttribute('aria-label') === buttonName).map(node => {
                const style = getComputedStyle(node)
                return { disabled: node.getAttribute('aria-disabled'), background: style.backgroundColor, opacity: style.opacity }
            }),
            summary: (document.body.innerText.match(/(?:Matthew|Every kingdom needs its Castle): \d+\/20 · IR \d+\/2 · Taxi \d+\/3/g) ?? []).sort(),
        })
        const samples = [{ at: performance.now(), ...capture() }]
        const observe = () => {
            const state = capture()
            const { at: _at, ...previous } = samples.at(-1)
            if (JSON.stringify(state) !== JSON.stringify(previous)) samples.push({ at: performance.now(), ...state })
        }
        const observer = new MutationObserver(observe)
        observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
        Reflect.set(window, 'offerStabilitySamples', samples)
        Reflect.set(window, 'offerStabilityObserver', observer)
    }, buttonName)
    await watch('Edit trade with Matthew')
    const initial = await page.evaluate(() => Reflect.get(window, 'offerStabilitySamples')[0])
    const cycles = []
    for (let cycle = 0; cycle < 3; cycle++) {
        const previousReads = tradeReads
        sql(`UPDATE public.trades SET notes=notes||'.' WHERE id='${trade}' AND league_id='${league}';`)
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
        await page.waitForFunction(() => Reflect.get(window, 'offerStabilitySamples').length > 0)
        for (let attempt = 0; attempt < 100 && tradeReads === previousReads; attempt++) await page.waitForTimeout(100)
        assert.ok(tradeReads > previousReads, 'Each cycle must reach the real trade view')
        await page.waitForTimeout(1500)
        cycles.push({ tradeReads, previewReads })
    }
    const samples = await page.evaluate(() => {
        Reflect.get(window, 'offerStabilityObserver').disconnect()
        return Reflect.get(window, 'offerStabilitySamples')
    })
    await page.screenshot({ path: `${output}/${phase}-refreshed.png`, fullPage: true })
    await writeFile(`${output}/${phase}-samples.json`, JSON.stringify({ initial, cycles, samples, errors }, null, 2))
    assert.deepEqual(errors, [])
    assertOfferStable(initial, samples)
    await page.getByTestId(`trade-edit-${trade}`).click()
    await page.getByTestId('trade-submit').click()
    await page.getByText('Matthew: 20/20 · IR 2/2 · Taxi 3/3', { exact: true }).filter({ visible: true }).waitFor()
    await page.getByText('Every kingdom needs its Castle: 21/20 · IR 1/2 · Taxi 3/3', { exact: true }).filter({ visible: true }).waitFor()
    await watch('Confirm and send trade')
    const editorInitial = await page.evaluate(() => Reflect.get(window, 'offerStabilitySamples')[0])
    const editorCycles = []
    for (let cycle = 0; cycle < 3; cycle++) {
        const previousVersion = BigInt(sql(`SELECT version FROM public.league_versions WHERE league_id='${league}'`))
        sql(`UPDATE public.trades SET notes=notes||'.' WHERE id='${trade}' AND league_id='${league}';`)
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
        const version = sql(`SELECT version FROM public.league_versions WHERE league_id='${league}'`)
        assert.ok(BigInt(version) > previousVersion, 'Each editor update must advance the real league version')
        await page.waitForTimeout(1500)
        editorCycles.push({ version })
    }
    const editorSamples = await page.evaluate(() => {
        Reflect.get(window, 'offerStabilityObserver').disconnect()
        return Reflect.get(window, 'offerStabilitySamples')
    })
    await page.screenshot({ path: `${output}/${phase}-editor.png`, fullPage: true })
    await writeFile(`${output}/${phase}-editor-samples.json`, JSON.stringify({ initial: editorInitial, cycles: editorCycles, samples: editorSamples, errors }, null, 2))
    assertOfferStable(editorInitial, editorSamples, 1)
    assert.equal(editorInitial.buttons[0].disabled, 'true')
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ phase, cycles: cycles.length, editorCycles: editorCycles.length, tradeReads, previewReads, states: samples.length, editorStates: editorSamples.length, stable: true }))
} catch (error) {
    await writeFile(`${output}/${phase}-failure.txt`, await page.locator('body').innerText())
    await page.screenshot({ path: `${output}/${phase}-failure.png`, fullPage: true })
    throw error
} finally {
    await context.close()
    await browser.close()
}

}

if (import.meta.url === `file://${process.argv[1]}`) await runTradeOfferStability()
