import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createBrowser, listBrowserSessions } from './browser-agent.mjs'
import { resolvedTradeEnv } from './env.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { setupTradeGameplayFixture, findAvailablePlayers } from './trade-fixture.mjs'

const env = resolvedTradeEnv()
for (const url of [env.supabaseUrl, env.apiBaseUrl, env.frontendUrl]) assert.equal(new URL(url).hostname, '127.0.0.1')
const output = process.env.E2E_BROWSER_ARTIFACT_DIR
assert.ok(output)
await mkdir(output, { recursive: true })
await listBrowserSessions({ cwd: process.cwd() })
const browser = createBrowser({ cwd: process.cwd() })
const session = `trade-legality-${process.pid}`
const b = (...args) => browser(session, args)
const read = async code => {
    const value = JSON.parse((await b('eval', `JSON.stringify(${code})`)).trim())
    return typeof value === 'string' ? JSON.parse(value) : value
}
const text = () => read('document.body.innerText')
const waitText = async value => {
    for (let i = 0; i < 30; i++) {
        if ((await text()).toLowerCase().includes(value.toLowerCase())) return
        await b('wait', '500')
    }
    throw new Error(`Missing ${value}: ${(await text()).slice(-1600)}`)
}
const click = async selector => { await b('scrollintoview', selector); await b('click', selector) }
const testId = id => `[data-testid="${id}"]`
const check = result => { if (result.error) throw new Error(result.error.message); return result.data }
await runWithScenarioResourceOwner('trade legality', async () => {
const fixture = await setupTradeGameplayFixture(env, 0, { includeFuturePicks: false, isolatedPlayers: true })
const receipt = {}
try {
    const extra = await findAvailablePlayers(fixture.admin, fixture.league.id, fixture.currentSeason.id, 4, fixture.registerCreatedPlayer, { createOnly: true })
    check(await fixture.admin.from('leagues').update({ roster_size: 2, ir_slots: 1, taxi_slots: 0, allow_inactive_trades: true, trade_veto_mode: 'commissioner', trade_veto_window_hours: 24 }).eq('id', fixture.league.id))
    check(await fixture.admin.from('players').update({ injury_status: 'Out' }).in('id', [fixture.proposerPlayer.id, fixture.recipientPlayer.id]))
    check(await fixture.admin.from('roster_players').update({ is_on_ir: true }).eq('league_id', fixture.league.id))
    check(await fixture.admin.from('roster_players').insert(extra.map((player, index) => ({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id, member_id: index < 2 ? fixture.proposer.id : fixture.recipient.id, player_id: player.id, acquired_via: 'draft' }))))
    const signIn = async index => {
        await b('open', `${env.frontendUrl}/sign-in`)
        await b('snapshot')
        await b('fill', '[placeholder="you@example.com"]', fixture.users[index].email)
        await b('fill', '[placeholder="Your password"]', fixture.password)
        await click('[aria-label="Sign In"]')
        await b('wait', '2500')
    }
    await b('set', 'viewport', '390', '844')
    await signIn(0)
    await b('open', `${env.frontendUrl}/propose-trade?recipientMemberId=${fixture.recipient.id}`)
    await waitText(`To ${fixture.recipient.team_name}`)
    await b('snapshot')
    await click(testId(`trade-sender-${fixture.recipient.id}`))
    await click(testId(`trade-${fixture.recipient.id}-player-${fixture.recipientPlayer.id}`))
    await click(testId(`trade-sender-${fixture.proposer.id}`))
    await click(testId(`trade-${fixture.proposer.id}-player-${fixture.proposerPlayer.id}`))
    await click(testId('trade-submit'))
    await waitText('Move 1 player to IR or drop 1')
    assert.equal(await read(`document.querySelector('[data-testid="trade-confirm-submit"]').getAttribute('aria-disabled')`), 'true')
    assert.ok(!(await text()).includes('requires an available'))
    await b('screenshot', `${output}/send-disabled.png`)
    await click(`[aria-label="Drop ${extra[0].display_name} at completion"]`)
    await waitText('Roster ready')
    assert.notEqual(await read(`document.querySelector('[data-testid="trade-confirm-submit"]').getAttribute('aria-disabled')`), 'true')
    await click(testId('trade-confirm-submit'))
    await b('wait', '1500')
    const offers = check(await fixture.admin.from('trades').select('id').eq('league_id', fixture.league.id))
    assert.equal(offers.length, 1)
    const offer = offers[0]
    receipt.proposerDropSaved = check(await fixture.admin.from('trade_participants').select('drop_player_ids').eq('trade_id', offer.id).eq('member_id', fixture.proposer.id).single()).drop_player_ids.includes(extra[0].id)
    assert.ok(receipt.proposerDropSaved)
    await b('close')
    await signIn(1)
    await b('open', `${env.frontendUrl}/trades`)
    await waitText('Incoming')
    await b('snapshot')
    await click(testId(`trade-details-${offer.id}`))
    await waitText('Move 1 player to IR or drop 1')
    const accept = `[aria-label="Accept trade with ${fixture.proposer.team_name}"]`
    assert.equal(await read(`document.querySelector(${JSON.stringify(accept)}).getAttribute('aria-disabled')`), 'true')
    await b('screenshot', `${output}/accept-disabled.png`)
    await click(`[aria-label="Drop ${extra[2].display_name} at completion"]`)
    await waitText('Roster ready')
    for (let i = 0; i < 30; i++) {
        if (await read(`document.querySelector(${JSON.stringify(accept)}).getAttribute('aria-disabled')`) !== 'true') break
        await b('wait', '500')
    }
    assert.notEqual(await read(`document.querySelector(${JSON.stringify(accept)}).getAttribute('aria-disabled')`), 'true')
    await click(accept)
    await waitText('Accept trade?')
    await click('[role="dialog"] [aria-label="Accept"]')
    await b('wait', '1000')
    const accepted = check(await fixture.admin.from('trades').select('status').eq('id', offer.id).single())
    assert.equal(accepted.status, 'accepted')
    receipt.acceptorDropSaved = check(await fixture.admin.from('trade_participants').select('drop_player_ids').eq('trade_id', offer.id).eq('member_id', fixture.recipient.id).single()).drop_player_ids.includes(extra[2].id)
    assert.ok(receipt.acceptorDropSaved)
    check(await fixture.admin.from('trades').update({ veto_window_expires_at: new Date(Date.now() - 60000).toISOString() }).eq('id', offer.id))
    check(await fixture.admin.rpc('complete_accepted_trade_atomic', { p_trade_id: offer.id }))
    const rosters = check(await fixture.admin.from('roster_players').select('member_id,is_on_ir,is_on_taxi,player_id').eq('league_season_id', fixture.currentSeason.id))
    for (const member of [fixture.proposer.id, fixture.recipient.id]) assert.equal(rosters.filter(row => row.member_id === member && !row.is_on_ir && !row.is_on_taxi).length, 2)
    assert.equal(rosters.length, 4)
    receipt.bothRostersLegal = true
    await b('open', `${env.frontendUrl}/trades?tab=history`)
    await waitText('Completed')
    await b('snapshot')
    receipt.sectionGap = await read(`(() => {
        const heading = document.querySelector('[data-testid="page-header-standard"]');
        const card = document.querySelector('[data-testid="trade-details-${offer.id}"]')?.parentElement;
        return heading && card ? { marginBottom: getComputedStyle(heading).marginBottom, gap: card.getBoundingClientRect().top - heading.getBoundingClientRect().bottom } : null;
    })()`)
    assert.ok(receipt.sectionGap && receipt.sectionGap.gap >= 8)
    await b('screenshot', `${output}/history-spacing.png`)
    await writeFile(`${output}/receipt.json`, JSON.stringify(receipt, null, 2))
    console.log(JSON.stringify(receipt))
} catch (error) {
    await writeFile(`${output}/failure.txt`, String(error) + '\n' + await b('snapshot').catch(() => ''))
    await b('screenshot', `${output}/failure.png`).catch(() => {})
    throw error
} finally {
    await b('close').catch(() => {})
    await listBrowserSessions({ cwd: process.cwd() })
    await fixture.dispose()
}

})
