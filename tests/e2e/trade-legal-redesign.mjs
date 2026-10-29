import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, devices, webkit } from 'playwright'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as wait } from 'node:timers/promises'
import { startTradeLegalServer } from './trade-legal-server.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { resolvedTradeEnv } from './env.mjs'
import { setupTradeGameplayFixture, findAvailablePlayers } from './trade-fixture.mjs'

const execFileAsync = promisify(execFile)
const env = resolvedTradeEnv()
for (const url of [env.supabaseUrl, env.apiBaseUrl, env.frontendUrl]) assert.equal(new URL(url).hostname, '127.0.0.1')
assert.equal(new URL(env.supabaseUrl).port, '61421')
assert.equal(new URL(env.frontendUrl).port, '61480')
const output = process.env.E2E_BROWSER_ARTIFACT_DIR
assert.ok(output)
await mkdir(output, { recursive: true })
const legacy = process.env.E2E_EXPECT_LEGACY === '1'
const check = result => { if (result.error) throw new Error(result.error.message); return result.data }
const receipt = { engine: 'WebKit', device: 'iPhone 13', widths: [320, 390], states: [], rowMeasurements: [], actions: [], checks: 0 }
const server = startTradeLegalServer(process.env.E2E_TRADE_WEB_DIR ?? '../review-web')
const browser = await webkit.launch({ headless: true })
try {
    for (const theme of legacy ? ['light'] : ['light', 'dark']) for (const scenario of legacy ? ['invalid'] : ['invalid', 'valid']) await runWithScenarioResourceOwner(`trade legal ${theme} ${scenario}`, async () => {
        const fixture = await setupTradeGameplayFixture(env, 0, { includeFuturePicks: true, isolatedPlayers: true })
        const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
        const origins = new Set([env.frontendUrl, env.supabaseUrl])
        await context.route('**/*', route => origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort())
        await context.addInitScript(value => localStorage.setItem('pancake-theme', value), theme)
        const page = await context.newPage()
        page.setDefaultTimeout(20000)
        const shot = async name => {
            if (!legacy && !name.startsWith('trades-list')) {
                const action = await page.getByTestId('trade-legality-screen').getByRole('button', { name: /^(Send|Accept)$/ }).evaluate(element => {
                    const label = element.firstElementChild ?? element
                    const style = getComputedStyle(label)
                    const box = label.getBoundingClientRect()
                    return { caption: label.textContent, color: style.color, opacity: style.opacity, visibility: style.visibility,
                        width: box.width, height: box.height, font: style.font, x: box.x, y: box.y }
                })
                assert.ok(action.caption?.trim() === 'Send' || action.caption?.trim() === 'Accept')
                assert.ok(action.width > 0 && action.height > 0)
                receipt.actions.push({ scenario, theme, name, ...action })
            }
            await page.screenshot({ path: `${output}/${scenario}-${name}.png`, animations: 'disabled' })
            receipt.states.push(`${scenario}-${name}`)
        }
        const themes = async name => {
            await page.getByTestId('trade-review-card').scrollIntoViewIfNeeded()
            await shot(`${name}-${theme}-390`)
        }
        const signIn = async (index, expected) => {
            await context.clearCookies()
            if (page.url().startsWith(env.frontendUrl)) await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
            await page.goto(`${env.frontendUrl}/sign-in`)
            await page.locator('#root').getByPlaceholder('you@example.com').fill(fixture.users[index].email)
            await page.locator('#root').getByPlaceholder('Your password').fill(fixture.password)
            await page.locator('#root').getByRole('button', { name: 'Sign In', exact: true }).click()
            await page.waitForURL(url => url.pathname === '/')
            await page.getByRole('link', { name: 'Roster', exact: true }).first().click()
            await page.getByText(expected, { exact: true }).first().waitFor()
        }
        const measureRows = async stage => {
            let broken = false
            for (const width of [320, 390]) {
                await page.setViewportSize({ width, height: 844 })
                const names = await page.getByTestId('player-name-line').evaluateAll(nodes => nodes.map(node => {
                    const box = node.getBoundingClientRect()
                    return { name: node.textContent, width: box.width, height: box.height }
                }).filter(row => row.width > 0))
                assert.ok(names.length > 0)
                if (legacy) broken ||= names.some(row => row.width < 100 || row.height > 48)
                else for (const row of names) {
                    assert.ok(row.width >= 100, `${row.name} has only ${row.width}px`)
                    assert.ok(row.height <= 48, `${row.name} is ${row.height}px tall`)
                }
                receipt.rowMeasurements.push({ scenario, theme, stage, width, names })
                await page.getByRole('radiogroup').last().scrollIntoViewIfNeeded()
                await shot(`${stage}-long-names-${theme === 'dark' ? 'dark-' : ''}${width}`)
            }
            if (legacy) assert.ok(broken, 'The old layout must fail the long-name guard')
        }
        try {
            const extra = await findAvailablePlayers(fixture.admin, fixture.league.id, fixture.currentSeason.id, 4, fixture.registerCreatedPlayer, { createOnly: true })
            const players = [fixture.proposerPlayer, fixture.recipientPlayer, ...extra]
            const names = [['Kentavious', 'Caldwell-Pope'], ['Nickeil', 'Alexander-Walker'], ['Shai', 'Gilgeous-Alexander'], ['Giannis', 'Antetokounmpo'], ['Wendell', 'Carter Jr.'], ['Timothe', 'Luwawu-Cabarrot']]
            for (let index = 0; index < players.length; index++) {
                check(await fixture.admin.from('players').update({ first_name: names[index][0], last_name: names[index][1],
                    injury_status: index < 2 ? 'Out' : null, years_exp: index === 0 ? 0 : 5, career_regular_season_games: index === 0 ? 0 : 200,
                }).eq('id', players[index].id))
                players[index].display_name = names[index].join(' ')
            }
            check(await fixture.admin.from('leagues').update({ roster_size: 2, ir_slots: 1, taxi_slots: 1, allow_inactive_trades: true,
                trade_veto_mode: 'commissioner', trade_veto_window_hours: 24 }).eq('id', fixture.league.id))
            check(await fixture.admin.from('roster_players').update({ is_on_ir: true }).eq('league_id', fixture.league.id))
            check(await fixture.admin.from('roster_players').insert(extra.map((player, index) => ({ league_id: fixture.league.id,
                league_season_id: fixture.currentSeason.id, member_id: index < 2 ? fixture.proposer.id : fixture.recipient.id,
                player_id: player.id, acquired_via: 'draft' }))))
            await signIn(0, players[0].display_name)
            await page.goto(`${env.frontendUrl}/propose-trade?recipientMemberId=${fixture.recipient.id}`)
            await page.getByTestId(`trade-sender-${fixture.recipient.id}`).click()
            await page.getByTestId(`trade-${fixture.recipient.id}-player-${fixture.recipientPlayer.id}`).click()
            await page.getByTestId(`trade-sender-${fixture.proposer.id}`).click()
            await page.getByTestId(`trade-${fixture.proposer.id}-player-${fixture.proposerPlayer.id}`).click()
            if (fixture.proposerFuturePick) await page.getByTestId(`trade-${fixture.proposer.id}-pick-${fixture.proposerFuturePick.id}`).click()
            await page.getByTestId('trade-submit').click()
            if (legacy) {
                await page.getByLabel(`${extra[0].display_name}: active`, { exact: true }).waitFor()
                await measureRows('before')
                return
            }
            const screen = page.getByTestId('trade-legality-screen')
            await screen.getByText('Invalid roster', { exact: true }).waitFor()
            assert.equal(await page.getByTestId('trade-confirm-submit').isDisabled(), true)
            assert.equal(await screen.getByLabel(`${extra[1].display_name}: taxi`, { exact: true }).isDisabled(), true)
            assert.equal(await screen.getByLabel(`${players[1].display_name}: taxi`, { exact: true }).isDisabled(), true)
            await themes('propose-invalid')
            await measureRows('propose')
            await screen.getByLabel(`Drop ${extra[0].display_name} at completion`, { exact: true }).click()
            await screen.getByText('Valid roster', { exact: true }).waitFor()
            assert.equal(await page.getByTestId('trade-confirm-submit').isDisabled(), false)
            const body = await screen.innerText()
            for (const forbidden of ['Roster ready', 'Resulting rosters', 'IR requires', 'Taxi requires', 'Value ', 'INCOMING SLOTS', 'will need to make room', ' — from ']) assert.ok(!body.includes(forbidden), forbidden)
            const card = await page.getByTestId('trade-review-card').boundingBox()
            const status = await page.getByTestId('trade-roster-status').boundingBox()
            assert.ok(card && status && status.y - card.y - card.height <= 16)
            await themes('propose-valid-send-enabled')
            await page.getByTestId('trade-confirm-submit').click()
            await page.waitForURL(url => !url.pathname.includes('propose-trade'))
            const [offer] = check(await fixture.admin.from('trades').select('id').eq('league_id', fixture.league.id))
            assert.ok(offer)
            const senderPlan = check(await fixture.admin.from('trade_participants').select('drop_player_ids').eq('trade_id', offer.id).eq('member_id', fixture.proposer.id).single())
            assert.deepEqual(senderPlan.drop_player_ids, [extra[0].id])
            if (scenario === 'valid') check(await fixture.admin.from('roster_players').delete().eq('league_id', fixture.league.id).eq('player_id', extra[2].id))
            await signIn(1, players[1].display_name)
            await page.goto(`${env.frontendUrl}/trades`)
            await page.getByTestId(`trade-accept-${offer.id}`).waitFor()
            if (scenario === 'invalid') {
                const list = await page.locator('body').innerText()
                assert.ok(list.includes('Round 1 (orig.'))
                assert.ok(!list.includes(' — from '))
                await shot(`trades-list-pick-${theme}-390`)
            }
            await page.getByTestId(`trade-accept-${offer.id}`).click()
            if (process.env.E2E_AGENT_BROWSER === '1' && scenario === 'valid' && theme === 'light') {
                const session = `trade-legal-${fixture.runId}`
                const cli = async args => (await execFileAsync('node_modules/.bin/agent-browser', ['--session', session, ...args], {
                    encoding: 'utf8', timeout: 30000, env: { ...process.env, AGENT_BROWSER_EXECUTABLE_PATH: chromium.executablePath() },
                })).stdout
                await execFileAsync('node_modules/.bin/agent-browser', ['session', 'list'])
                try {
                    await cli(['open', `${env.frontendUrl}/sign-in`])
                    await cli(['set', 'viewport', '390', '844'])
                    await cli(['snapshot'])
                    await cli(['fill', 'input[placeholder="you@example.com"]', fixture.users[1].email])
                    await cli(['fill', 'input[placeholder="Your password"]', fixture.password])
                    await cli(['find', 'role', 'button', 'click', '--name', 'Sign In', '--exact'])
                    await cli(['wait', '--url', env.frontendUrl + '/'])
                    await cli(['open', `${env.frontendUrl}/trades`])
                    await cli(['wait', `[data-testid="trade-accept-${offer.id}"]`])
                    await cli(['snapshot'])
                    await cli(['click', `[data-testid="trade-accept-${offer.id}"]`])
                    await cli(['wait', '--text', 'Valid roster'])
                    const snapshot = await cli(['snapshot'])
                    assert.ok(snapshot.includes('Valid roster') && snapshot.includes('Accept'))
                    await writeFile(`${output}/agent-browser-accept.txt`, snapshot)
                    await cli(['screenshot', `${output}/agent-browser-accept-390.png`])
                } finally {
                    await cli(['close'])
                    let closed = false
                    for (let attempt = 0; attempt < 25; attempt++) {
                        const sessions = await execFileAsync('node_modules/.bin/agent-browser', ['session', 'list'])
                        if (!sessions.stdout.includes(session)) { closed = true; break }
                        await wait(200)
                    }
                    assert.ok(closed)
                }
            }
            const acceptScreen = page.getByTestId('trade-legality-screen')
            await acceptScreen.getByText(scenario === 'valid' ? 'Valid roster' : 'Invalid roster', { exact: true }).waitFor()
            assert.equal(await page.getByTestId('trade-confirm-accept').isDisabled(), scenario === 'invalid')
            await themes(`accept-${scenario}`)
            await measureRows(`accept-${scenario}`)
            if (scenario === 'invalid') await acceptScreen.getByLabel(`Drop ${extra[2].display_name} at completion`, { exact: true }).click()
            else await acceptScreen.getByLabel(`${players[0].display_name}: ir`, { exact: true }).click()
            await acceptScreen.getByText('Valid roster', { exact: true }).waitFor()
            assert.equal(await page.getByTestId('trade-confirm-accept').isDisabled(), false)
            await themes(scenario === 'valid' ? 'accept-incoming-ir' : 'accept-fixed-enabled')
            if (scenario === 'valid') {
                const taxi = acceptScreen.getByLabel(`${players[0].display_name}: taxi`, { exact: true })
                assert.equal(await taxi.isDisabled(), false)
                await taxi.click()
                await acceptScreen.getByText('Valid roster', { exact: true }).waitFor()
                assert.equal(await page.getByTestId('trade-confirm-accept').isDisabled(), false)
                await themes('accept-incoming-taxi')
            }
            await page.getByTestId('trade-confirm-accept').click()
            await page.getByTestId('trade-legality-screen').waitFor({ state: 'hidden' })
            assert.equal(check(await fixture.admin.from('trades').select('status').eq('id', offer.id).single()).status, 'accepted')
            const plan = check(await fixture.admin.from('trade_participants').select('drop_player_ids').eq('trade_id', offer.id).eq('member_id', fixture.recipient.id).single())
            assert.deepEqual(plan.drop_player_ids, scenario === 'invalid' ? [extra[2].id] : [])
            const incoming = check(await fixture.admin.from('trade_items').select('to_ir,to_taxi').eq('trade_id', offer.id).eq('player_id', players[0].id).single())
            assert.equal(incoming.to_ir, false)
            assert.equal(incoming.to_taxi, scenario === 'valid')
            receipt.checks += 15
        } catch (error) {
            await shot('failure').catch(() => {})
            await writeFile(`${output}/${scenario}-failure.txt`, String(error) + '\n' + await page.locator('body').innerText().catch(() => ''))
            throw error
        } finally {
            await context.close()
            await fixture.dispose()
        }
    })
    await writeFile(`${output}/receipt.json`, JSON.stringify(receipt, null, 2))
    console.log(JSON.stringify({ states: receipt.states.length, checks: receipt.checks, legacy }))
} finally {
    await browser.close()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve(undefined)))
}
