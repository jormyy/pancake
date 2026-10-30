import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { webkit } from 'playwright'


export function assertPrivateLockStack(url) {
    const parsed = new URL(url)
    assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.port === '59821' && parsed.protocol === 'http:')
}

async function main() {
const root = path.resolve('..')
const fixture = JSON.parse((await readFile(path.join(root, 'browser-fixture.log'), 'utf8')).split('\n').find(line => line.startsWith('{')))
const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
assertPrivateLockStack(status.API_URL)
const client = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false } })
const { data, error } = await client.auth.signInWithPassword({ email: fixture.email, password: 'Local-locks-598-test' })
assert.ifError(error)
const output = path.join(root, 'screenshots')
await mkdir(output, { recursive: true })
const browser = await webkit.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
await context.addInitScript(session => localStorage.setItem('sb-127-auth-token', JSON.stringify(session)), data.session)
await context.route('**/*', route => {
    const url = new URL(route.request().url())
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort()
})
const page = await context.newPage()
const failures = []
page.on('pageerror', error => failures.push(error.message))
const screenshots = []
const open = async url => { await page.waitForLoadState('networkidle'); await page.goto(url) }
try {
    await open('http://127.0.0.1:59880/roster')
    await page.getByLabel('Asset locked', { exact: true }).first().waitFor({ timeout: 60000 })
    assert.ok(await page.getByRole('link', { name: /^Locked by trade/ }).count())
    await page.screenshot({ path: path.join(output, 'roster-locks-390.png'), fullPage: true })
    screenshots.push('roster-locks-390.png')
    await page.getByText('2027 Round 1', { exact: true }).first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(output, 'roster-pick-lock-390.png'), fullPage: true })
    screenshots.push('roster-pick-lock-390.png')
    await page.getByRole('button', { name: 'Open Anthony Edwards', exact: true }).first().click()
    await page.getByRole('button', { name: 'Drop Anthony Edwards', exact: true }).waitFor()
    assert.ok(await page.getByRole('button', { name: 'Drop Anthony Edwards', exact: true }).isDisabled())
    await page.screenshot({ path: path.join(output, 'roster-actions-390.png'), fullPage: true })
    screenshots.push('roster-actions-390.png')
    await open('http://127.0.0.1:59880/lineup')
    await page.getByRole('button', { name: 'Bench Anthony Edwards', exact: true }).waitFor({ timeout: 30000 })
    assert.equal(await page.getByLabel('Asset locked', { exact: true }).count(), 0)
    assert.equal(await page.getByRole('link', { name: /^Locked by trade/ }).count(), 0)
    await page.screenshot({ path: path.join(output, 'lineup-locks-390.png'), fullPage: true })
    screenshots.push('lineup-locks-390.png')
    await open('http://127.0.0.1:59880/players?section=waivers')
    await page.getByLabel('Asset locked', { exact: true }).first().waitFor({ timeout: 30000 })
    assert.ok(await page.getByRole('link', { name: /^Locked by waiver claim/ }).count())
    await page.screenshot({ path: path.join(output, 'waiver-locks-390.png'), fullPage: true })
    screenshots.push('waiver-locks-390.png')
    await open(`http://127.0.0.1:59880/propose-trade?recipientMemberId=${fixture.otherMemberId}`)
    await page.getByLabel('Asset locked', { exact: true }).first().waitFor({ timeout: 30000 })
    assert.ok(await page.getByRole('button', { name: 'Select Anthony Edwards for trade', exact: true }).isDisabled())
    assert.ok(await page.locator(`[id="trade-${fixture.memberId}-pick-${fixture.pickId}"]`).isDisabled())
    await page.screenshot({ path: path.join(output, 'trade-locks-390.png'), fullPage: true })
    screenshots.push('trade-locks-390.png')
    if (process.argv.includes('--remaining')) {
        await page.setViewportSize({ width: 1600, height: 1000 })
        await open('http://127.0.0.1:59880/roster')
        const moveToIR = page.getByRole('button', { name: 'Move to IR Anthony Edwards', exact: true })
        await moveToIR.waitFor({ timeout: 30000 })
        assert.ok(await moveToIR.isDisabled(), 'The wide roster must disable moves for a locked player')
        await page.screenshot({ path: path.join(output, 'roster-wide-locks-1600.png'), fullPage: true })
        screenshots.push('roster-wide-locks-1600.png')
        await page.setViewportSize({ width: 390, height: 844 })
    }
    if (process.argv.includes('--remaining') || process.argv.includes('--picker-only')) {
        await open(`http://127.0.0.1:59880/claim-player?playerId=${fixture.playerIds[5]}`)
        const tradeDrop = page.getByRole('button', { name: 'Select Anthony Edwards to drop', exact: true })
        const waiverDrop = page.getByRole('button', { name: 'Select Jayson Tatum to drop', exact: true })
        const freeDrop = page.getByRole('button', { name: 'Select LeBron James to drop', exact: true })
        await tradeDrop.waitFor({ timeout: 30000 })
        assert.ok(await tradeDrop.isDisabled(), 'The waiver picker must disable a pending-trade asset')
        assert.ok(await waiverDrop.isDisabled(), 'The waiver picker must disable another claim drop')
        assert.equal(await freeDrop.isDisabled(), false)
        await tradeDrop.scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(output, 'waiver-picker-locks-390.png'), fullPage: true })
        screenshots.push('waiver-picker-locks-390.png')
        await freeDrop.click()
        assert.equal(await page.getByRole('button', { name: 'Submit waiver claim', exact: true }).isDisabled(), false)
        await open(`http://127.0.0.1:59880/claim-player?playerId=${fixture.playerIds[4]}&claimId=${fixture.claimId}`)
        await waiverDrop.waitFor({ timeout: 30000 })
        assert.equal(await waiverDrop.isDisabled(), false, 'Editing a claim keeps its own selected drop available')
        assert.equal(await tradeDrop.isDisabled(), true)
        assert.equal(await page.getByRole('button', { name: 'Save waiver claim', exact: true }).isDisabled(), false)
        await page.screenshot({ path: path.join(output, 'waiver-picker-edit-390.png'), fullPage: true })
        screenshots.push('waiver-picker-edit-390.png')
    }
    if (process.argv.includes('--cancel')) {
        const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false } })
        if (process.argv.includes('--remaining')) {
            await open(`http://127.0.0.1:59880/claim-player?playerId=${fixture.playerIds[5]}`)
            await page.getByRole('button', { name: 'Select Anthony Edwards to drop', exact: true }).waitFor()
        } else {
            await open('http://127.0.0.1:59880/roster')
            await page.getByRole('link', { name: /^Locked by trade/ }).first().waitFor()
        }
        const withdrawn = await admin.rpc('withdraw_trade_atomic', { p_trade_id: fixture.tradeId, p_member_id: fixture.memberId, p_user_id: fixture.userId })
        assert.ifError(withdrawn.error)
        await page.waitForFunction(() => !document.body.innerText.includes('Locked by trade'), { timeout: 45000 })
        const cancelled = await admin.rpc('cancel_waiver_claim_atomic', { p_claim_id: fixture.claimId, p_member_id: fixture.memberId, p_user_id: fixture.userId })
        assert.ifError(cancelled.error)
        await page.waitForFunction(() => !document.querySelector('[aria-label="Asset locked"]'), { timeout: 45000 })
        if (process.argv.includes('--remaining')) {
            assert.equal(await page.getByRole('button', { name: 'Select Anthony Edwards to drop', exact: true }).isDisabled(), false)
            assert.equal(await page.getByRole('button', { name: 'Select Jayson Tatum to drop', exact: true }).isDisabled(), false)
            await page.screenshot({ path: path.join(output, 'waiver-picker-released-390.png'), fullPage: true })
            screenshots.push('waiver-picker-released-390.png')
            await open('http://127.0.0.1:59880/roster')
        }
        await page.screenshot({ path: path.join(output, 'roster-unlocked-390.png'), fullPage: true })
        screenshots.push('roster-unlocked-390.png')
        if (process.argv.includes('--remaining')) {
            for (const id of [fixture.leagueId, fixture.seasonId, fixture.memberId, fixture.playerIds[5]]) assert.match(id, /^[0-9a-f-]{36}$/)
            const changed = await admin.rpc('toggle_ir_atomic', { p_roster_player_id: fixture.rosterIds[0], p_to_ir: true, p_user_id: fixture.userId })
            assert.ifError(changed.error)
            execFileSync('psql', ['postgresql://postgres:postgres@127.0.0.1:59822/postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-c', `BEGIN;
                UPDATE public.leagues SET taxi_slots=1 WHERE id='${fixture.leagueId}';
                UPDATE public.players SET years_exp=0,career_regular_season_games=0 WHERE id='${fixture.playerIds[5]}';
                SELECT private.authorize_taxi_acquisition('${fixture.leagueId}','${fixture.seasonId}','${fixture.memberId}','${fixture.playerIds[5]}','draft',gen_random_uuid());
                INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,is_on_taxi,acquired_via)
                  VALUES('${fixture.leagueId}','${fixture.seasonId}','${fixture.memberId}','${fixture.playerIds[5]}',true,'draft');
                COMMIT;`], { stdio: ['ignore', 'ignore', 'pipe'] })
            const reserved = await admin.rpc('propose_trade_atomic', {
                p_league_id: fixture.leagueId, p_league_season_id: fixture.seasonId,
                p_proposer_member_id: fixture.memberId, p_recipient_member_id: fixture.otherMemberId,
                p_offer_player_ids: [fixture.playerIds[0], fixture.playerIds[5]], p_request_player_ids: [fixture.playerIds[3]],
                p_offer_pick_ids: [], p_request_pick_ids: [],
            })
            assert.ifError(reserved.error)
            await open('http://127.0.0.1:59880/lineup')
            const reserve = page.getByLabel('IR Anthony Edwards', { exact: true })
            await reserve.waitFor()
            await reserve.scrollIntoViewIfNeeded()
            assert.equal(await reserve.locator('..').getByLabel('Asset locked', { exact: true }).count(), 0)
            assert.equal(await page.getByLabel('Taxi Victor Wembanyama', { exact: true }).locator('..').getByLabel('Asset locked', { exact: true }).count(), 0)
            await page.screenshot({ path: path.join(output, 'lineup-reserve-locks-390.png'), fullPage: true })
            screenshots.push('lineup-reserve-locks-390.png')
            await page.setViewportSize({ width: 1600, height: 1000 })
            await open('http://127.0.0.1:59880/roster')
            const activate = page.getByRole('button', { name: 'Activate Anthony Edwards', exact: true })
            await activate.waitFor()
            assert.equal(await activate.isDisabled(), true)
            assert.equal(await page.getByRole('button', { name: 'Activate Victor Wembanyama', exact: true }).isDisabled(), true)
            await page.getByRole('link', { name: /^Locked by trade/ }).last().scrollIntoViewIfNeeded()
            await page.screenshot({ path: path.join(output, 'roster-wide-reserve-locks-1600.png'), fullPage: true })
            screenshots.push('roster-wide-reserve-locks-1600.png')
            const released = await admin.rpc('withdraw_trade_atomic', { p_trade_id: reserved.data, p_member_id: fixture.memberId, p_user_id: fixture.userId })
            assert.ifError(released.error)
        }
    }
    assert.deepEqual(failures, [])
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ engine: 'WebKit', widths: process.argv.includes('--remaining') ? [390,1600] : [390], screenshots, pageErrors: failures }, null, 2))
    console.log(`PASS: ${screenshots.length} WebKit lock captures at ${process.argv.includes('--remaining') ? '390px and 1600px' : '390px'}`)
} catch (error) {
    await page.screenshot({ path: path.join(output, 'failure-390.png'), fullPage: true })
    await writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText())
    throw error
} finally {
    await context.close()
    await browser.close()
}

}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
