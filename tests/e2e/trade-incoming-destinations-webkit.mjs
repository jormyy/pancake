import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { webkit } from 'playwright'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { resolvedTradeEnv } from './env.mjs'
import { setupTradeGameplayFixture, findAvailablePlayers } from './trade-fixture.mjs'

const env = resolvedTradeEnv()
for (const url of [env.supabaseUrl, env.apiBaseUrl, env.frontendUrl]) assert.equal(new URL(url).hostname, '127.0.0.1')
const output = process.env.E2E_BROWSER_ARTIFACT_DIR
assert.ok(output)
await mkdir(output, { recursive: true })
const check = result => { if (result.error) throw new Error(result.error.message); return result.data }
const receipt = { engine: 'WebKit', width: 390, states: [], scenarios: [] }
const browser = await webkit.launch({ headless: true })
try {
    for (const destination of ['ir', 'taxi', 'cancel']) await runWithScenarioResourceOwner(`incoming ${destination}`, async () => {
        const fixture = await setupTradeGameplayFixture(env, 0, { includeFuturePicks: false, isolatedPlayers: true })
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
        await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
        const page = await context.newPage()
        page.setDefaultTimeout(20000)
        const shot = async name => {
            const file = `${destination}-${name}.png`
            await page.screenshot({ path: `${output}/${file}` })
            receipt.states.push(file)
        }
        const focusPlayer = async name => {
            const player = page.getByText(name, { exact: true }).first()
            await player.scrollIntoViewIfNeeded()
            for (let attempt = 0; attempt < 4; attempt++) {
                const box = await player.boundingBox()
                assert.ok(box)
                if (box.y >= 110 && box.y + box.height < 720) return
                await page.mouse.move(195, 400)
                await page.mouse.wheel(0, box.y - 280)
                await page.waitForTimeout(150)
            }
            const box = await player.boundingBox()
            assert.ok(box && box.y >= 110 && box.y + box.height < 720)
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
        const rosters = async () => check(await fixture.admin.from('roster_players').select('member_id,player_id,is_on_ir,is_on_taxi').eq('league_season_id', fixture.currentSeason.id).order('player_id'))
        const openDetails = async id => {
            await page.goto(`${env.frontendUrl}/trades?tab=history`)
            await page.getByTestId(`trade-details-${id}`).click()
        }
        try {
            const extra = await findAvailablePlayers(fixture.admin, fixture.league.id, fixture.currentSeason.id, 5, fixture.registerCreatedPlayer, { createOnly: true })
            const all = [fixture.proposerPlayer, fixture.recipientPlayer, ...extra]
            const labels = ['Incoming Player', 'Return Player', 'Sender IR Move', 'Sender Taxi Move', 'Sender Drop', 'Recipient Regular', 'Recipient Added']
            for (let index = 0; index < all.length; index++) {
                const player = all[index]
                check(await fixture.admin.from('players').update({ first_name: destination.toUpperCase(), last_name: labels[index],
                    injury_status: [0, 1, 2].includes(index) ? 'Out' : null, years_exp: index < 4 ? 0 : 4,
                    career_regular_season_games: index < 4 ? 0 : 200 }).eq('id', player.id))
                player.display_name = `${destination.toUpperCase()} ${labels[index]}`
            }
            const [outgoing, incoming, retainedIR, retainedTaxi, drop, regular, added] = all
            check(await fixture.admin.from('leagues').update({ roster_size: 2, ir_slots: 2, taxi_slots: 2, allow_inactive_trades: true,
                trade_veto_mode: 'commissioner', trade_veto_window_hours: 24 }).eq('id', fixture.league.id))
            check(await fixture.admin.from('roster_players').update({ is_on_ir: true }).eq('player_id', incoming.id).eq('league_id', fixture.league.id))
            check(await fixture.admin.from('roster_players').insert([retainedIR, retainedTaxi, drop, regular].map(player => ({
                league_id: fixture.league.id, league_season_id: fixture.currentSeason.id,
                member_id: player.id === regular.id ? fixture.recipient.id : fixture.proposer.id, player_id: player.id, acquired_via: 'draft',
            }))))
            const senderSlot = destination === 'taxi' ? 'taxi' : 'ir'
            const compose = async (recipientSlot = null) => {
                await page.goto(`${env.frontendUrl}/propose-trade?recipientMemberId=${fixture.recipient.id}`)
                await page.getByTestId(`trade-sender-${fixture.recipient.id}`).click()
                await page.getByTestId(`trade-${fixture.recipient.id}-player-${incoming.id}`).click()
                await page.getByTestId(`trade-sender-${fixture.proposer.id}`).click()
                await page.getByTestId(`trade-${fixture.proposer.id}-player-${outgoing.id}`).click()
                await page.getByTestId('trade-submit').click()
                await page.getByLabel(`${incoming.display_name}: ${senderSlot}`, { exact: true }).click()
                await page.getByLabel(`${retainedIR.display_name}: ir`, { exact: true }).click()
                await page.getByLabel(`${retainedTaxi.display_name}: taxi`, { exact: true }).click()
                await page.getByLabel(`Drop ${drop.display_name} at completion`, { exact: true }).click()
                if (recipientSlot) await page.getByLabel(`${outgoing.display_name}: ${recipientSlot}`, { exact: true }).click()
                await page.getByText('Roster ready', { exact: true }).first().waitFor()
                await shot(recipientSlot ? '09-released-terms-reoffered' : '01-sender-plan')
                await page.getByTestId('trade-confirm-submit').click()
                await page.waitForURL(url => !url.pathname.includes('propose-trade'))
                return check(await fixture.admin.from('trades').select('id').eq('league_id', fixture.league.id).eq('status', 'pending').single()).id
            }
            await signIn(0, outgoing.display_name)
            const tradeId = await compose()
            const savedSender = check(await fixture.admin.from('trade_participants').select('drop_player_ids,roster_moves').eq('trade_id', tradeId).eq('member_id', fixture.proposer.id).single())
            assert.deepEqual(savedSender.drop_player_ids, [drop.id])
            assert.deepEqual(new Set(savedSender.roster_moves.map(move => `${move.playerId}:${move.destination}`)), new Set([`${retainedIR.id}:ir`, `${retainedTaxi.id}:taxi`]))
            assert.equal(check(await fixture.admin.from('trade_items').select('to_ir,to_taxi').eq('trade_id', tradeId).eq('player_id', incoming.id).single())[senderSlot === 'ir' ? 'to_ir' : 'to_taxi'], true)
            check(await fixture.admin.from('roster_players').insert({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id,
                member_id: fixture.recipient.id, player_id: added.id, acquired_via: 'draft' }))
            const before = await rosters()
            if (destination === 'cancel') check(await fixture.admin.from('players').update({ injury_status: null, years_exp: 4, career_regular_season_games: 200 }).eq('id', outgoing.id))
            await signIn(1, incoming.display_name)
            await page.goto(`${env.frontendUrl}/trades`)
            await page.getByTestId(`trade-details-${tradeId}`).click()
            await page.getByLabel(`Accept trade with ${fixture.proposer.team_name}`, { exact: true }).click()
            await page.getByText('Make it legal', { exact: true }).waitFor()
            await page.getByText(/Regular roster is 1 over/).first().waitFor()
            await shot('02-accept-needs-placement')
            const recipientSlot = destination === 'taxi' ? 'taxi' : 'ir'
            if (destination === 'cancel') {
                for (const slot of ['ir', 'taxi']) {
                    const option = page.getByLabel(`${outgoing.display_name}: ${slot}`, { exact: true })
                    assert.equal(await option.getAttribute('aria-disabled'), 'true')
                    assert.equal(await option.getAttribute('aria-checked'), 'false')
                }
                await page.getByText('IR requires an Out or IR designation.', { exact: true }).last().waitFor()
                await page.getByText('Taxi requires a rookie or fewer than 65 known career games.', { exact: true }).last().waitFor()
                await page.getByLabel(`${outgoing.display_name} roster slot`, { exact: true }).scrollIntoViewIfNeeded()
                await shot('03-ineligible-ir-and-taxi')
                check(await fixture.admin.from('players').update({ injury_status: 'Out', years_exp: 0, career_regular_season_games: 0 }).eq('id', outgoing.id))
                await page.getByRole('button', { name: 'Cancel', exact: true }).click()
                await page.getByLabel(`Accept trade with ${fixture.proposer.team_name}`, { exact: true }).click()
            }
            await page.getByLabel(`${outgoing.display_name}: ${recipientSlot}`, { exact: true }).click()
            await page.getByText('Ready for review. Nothing moves yet.', { exact: true }).waitFor()
            assert.equal(await page.getByLabel(`${outgoing.display_name}: ${recipientSlot}`, { exact: true }).getAttribute('aria-checked'), 'true')
            await shot('04-incoming-slot-ready')
            await page.getByRole('button', { name: 'Confirm', exact: true }).click()
            await page.getByText('Roster choices saved. Waiting for review and execution.', { exact: true }).waitFor()
            const trade = check(await fixture.admin.from('trades').select('status,veto_window_expires_at').eq('id', tradeId).single())
            assert.equal(trade.status, 'accepted')
            assert.ok(Date.parse(trade.veto_window_expires_at) > Date.now() + 23 * 3600000)
            assert.deepEqual(await rosters(), before)
            assert.equal(check(await fixture.admin.from('trade_items').select('to_ir,to_taxi').eq('trade_id', tradeId).eq('player_id', outgoing.id).single())[recipientSlot === 'ir' ? 'to_ir' : 'to_taxi'], true)
            await openDetails(tradeId)
            await page.getByText(/Veto window closes/).first().waitFor()
            await shot('05-review-window')
            if (destination === 'cancel') {
                await signIn(0, outgoing.display_name)
                await openDetails(tradeId)
                await page.getByRole('button', { name: 'Cancel trade', exact: true }).click()
                await page.getByText('Cancel trade?', { exact: true }).waitFor()
                await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"]')].some(element => {
                    const box = element.getBoundingClientRect()
                    return element.textContent?.includes('Cancel trade?') && box.y >= 0 && box.bottom <= window.innerHeight + 1
                }))
                await shot('cancel-confirmation')
                const [withdrawal] = await Promise.all([
                    page.waitForResponse(response => response.url().endsWith(`/trades/${tradeId}/withdraw`) && response.status() === 200),
                    page.getByRole('button', { name: 'Cancel trade', exact: true }).last().click(),
                ])
                await withdrawal.finished()
                assert.equal(check(await fixture.admin.from('trades').select('status').eq('id', tradeId).single()).status, 'withdrawn')
                assert.deepEqual(await rosters(), before)
                await page.getByText('Trade cancelled. Saved roster choices did not run.', { exact: true }).waitFor()
                await shot('cancellation-saved')
                await page.goto(`${env.frontendUrl}/trades?tab=history`)
                await page.getByText('Withdrawn', { exact: true }).first().waitFor()
                await shot('06-cancelled-during-review')
                await page.goto(`${env.frontendUrl}/roster`)
                await page.getByText(drop.display_name, { exact: true }).first().waitFor()
                await focusPlayer(drop.display_name)
                await shot('07-sender-moves-unapplied')
                await signIn(1, incoming.display_name)
                await focusPlayer(incoming.display_name)
                await shot('08-recipient-unchanged')
                await signIn(0, outgoing.display_name)
                await compose('ir')
                assert.deepEqual(await rosters(), before)
            } else {
                check(await fixture.admin.from('trades').update({ veto_window_expires_at: new Date(Date.now() - 60000).toISOString() }).eq('id', tradeId))
                check(await fixture.admin.rpc('complete_accepted_trade_atomic', { p_trade_id: tradeId }))
                assert.equal(check(await fixture.admin.from('trades').select('status').eq('id', tradeId).single()).status, 'completed')
                const after = await rosters()
                assert.ok(after.some(row => row.player_id === outgoing.id && row.member_id === fixture.recipient.id && row[recipientSlot === 'ir' ? 'is_on_ir' : 'is_on_taxi']))
                assert.ok(after.some(row => row.player_id === incoming.id && row.member_id === fixture.proposer.id && row[senderSlot === 'ir' ? 'is_on_ir' : 'is_on_taxi']))
                assert.ok(after.some(row => row.player_id === retainedIR.id && row.is_on_ir))
                assert.ok(after.some(row => row.player_id === retainedTaxi.id && row.is_on_taxi))
                assert.ok(!after.some(row => row.player_id === drop.id))
                for (const memberId of [fixture.proposer.id, fixture.recipient.id]) {
                    const own = after.filter(row => row.member_id === memberId)
                    assert.ok(own.filter(row => !row.is_on_ir && !row.is_on_taxi).length <= 2)
                    assert.ok(own.filter(row => row.is_on_ir).length <= 2)
                    assert.ok(own.filter(row => row.is_on_taxi).length <= 2)
                }
                await page.goto(`${env.frontendUrl}/roster`)
                await page.getByText(outgoing.display_name, { exact: true }).first().waitFor()
                await focusPlayer(outgoing.display_name)
                await shot('06-incoming-slot-executed')
                await signIn(0, incoming.display_name)
                await focusPlayer(retainedIR.display_name)
                await shot('07-sender-moves-executed')
                await focusPlayer(retainedTaxi.display_name)
                await shot('08-sender-taxi-executed')
            }
            receipt.scenarios.push({ destination, acceptanceSavedIncomingSlot: true, reviewWindowUnchanged: true,
                senderPlanSaved: true, executed: destination !== 'cancel', cancelledAndReoffered: destination === 'cancel' })
        } catch (error) {
            await shot('failure').catch(() => {})
            await writeFile(`${output}/${destination}-failure.txt`, String(error) + '\n' + await page.locator('body').innerText().catch(() => ''))
            throw error
        } finally {
            await context.close()
            await fixture.dispose()
        }
    })
    await writeFile(`${output}/receipt.json`, JSON.stringify(receipt, null, 2))
    process.stdout.write(JSON.stringify(receipt) + '\n')
} finally {
    await browser.close()
}
