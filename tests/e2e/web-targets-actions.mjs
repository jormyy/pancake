import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WEB_TARGETS, openWebTarget, pressWebControl, readWebLayout, pinWebTargetLeague, navigateWebTarget, reloadWebTarget, waitForWebAuthForm } from './web-targets-browser.mjs'
import { setupTradeGameplayFixture, findAvailablePlayers, createFixtureResourceOwner } from './trade-fixture.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { auditWebDraftActions } from './web-targets-draft-actions.mjs'
import { auditWebCommissionerActions } from './web-targets-commissioner-actions.mjs'
import { auditWebPlayerActions } from './web-targets-player-actions.mjs'
import { auditWebAuthActions } from './web-targets-auth-actions.mjs'
import { auditWebNotificationActions } from './web-targets-notification-actions.mjs'
import { auditWebMockActions } from './web-targets-mock-actions.mjs'
import { auditWebPanelActions } from './web-targets-panel-actions.mjs'
import { auditWebInviteActions } from './web-targets-invite-actions.mjs'
import { ensureSyntheticSeasonWeeks } from './soak-fixtures.mjs'

const root = process.cwd()
const db = async (operation) => { const result = await operation; if (result.error) throw new Error(result.error.message ?? String(result.error)); return result.data }
const wait = async (probe) => { for (let i = 0; i < 100; i += 1) { if (await probe()) return; await new Promise((resolve) => setTimeout(resolve, 200)) } throw new Error('Saved state did not match the browser action') }

export async function runWebActionTargets({ artifactDir, season = 0 }) {
  const frontend = process.env.E2E_FRONTEND_URL ?? 'http://127.0.0.1:8082'
  assert.equal(new URL(frontend).hostname, '127.0.0.1')
  assert.equal(new URL(process.env.E2E_SUPABASE_URL).hostname, '127.0.0.1')
  const env = { supabaseUrl: process.env.E2E_SUPABASE_URL, anonKey: process.env.E2E_SUPABASE_PUBLISHABLE_KEY,
    serviceRoleKey: process.env.E2E_PANCAKE_SUPABASE_SECRET_KEY, frontendUrl: frontend, apiBaseUrl: process.env.E2E_API_BASE_URL }
  const results = []
  for (const target of WEB_TARGETS.filter((target) => !process.env.E2E_WEB_TARGET_FILTER || target.id.includes(process.env.E2E_WEB_TARGET_FILTER))) {
    await runWithScenarioResourceOwner('extra web actions', async (resourceOwner) => {
      const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true })
      const calendarYears = new Set()
      const extra = createFixtureResourceOwner(fixture.admin)
      const dir = path.join(artifactDir, target.id)
      await mkdir(dir, { recursive: true })
      const { browser, context, page } = await openWebTarget(target, dir, { serviceWorkers: 'block' })
      const panels = []
      const api = []
      page.on('response', async (response) => {
        if (!response.url().includes('/functions/v1/api/')) return
        const entry = { url: response.url(), status: response.status(), error: null }
        api.push(entry)
        if (response.status() >= 400) entry.error = await response.json().then((body) => body.error ?? body.message ?? null).catch(() => 'Unreadable error response')
      })
      const inspect = async () => {
        const layout = await readWebLayout(page, target.insets)
        assert.equal(layout.client.width, target.viewport.width)
        assert.equal(layout.client.height, target.viewport.height)
        assert.ok(layout.overflow <= 1, `Horizontal overflow: ${layout.overflow}px`)
        for (const input of layout.inputs) assert.ok(input.font >= 16, `${input.label}: ${input.font}px text input`)
        const sheets = await page.locator('[id^="sheet-"]:not([id^="sheet-title-"])').evaluateAll((nodes) => nodes
          .filter((node) => node.isConnected && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
          .map((node) => { const rect = node.getBoundingClientRect(); return { bottom: parseFloat(getComputedStyle(node).paddingBottom), x: rect.x, right: rect.right } }))
        for (const detail of sheets) {
          assert.ok(detail.x >= -1 && detail.right <= target.viewport.width + 1, 'Sheet clips horizontally')
          if (target.mobile) assert.equal(detail.bottom, target.insets.bottom, 'Sheet must apply its bottom inset once')
        }
        panels.push({ inputs: layout.inputs, overflow: layout.overflow, sheets })
      }
      const press = async (locator) => {
        await locator.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest' }))
        await pressWebControl(target, locator)
        await page.waitForTimeout(100)
        await inspect()
      }
      const button = (name) => page.getByRole('button', { name, exact: true })
      const open = async (route) => { await navigateWebTarget(page, new URL(route, frontend).href); await page.getByRole('navigation', { name: 'Primary', exact: true }).waitFor() }
      const signIn = async (next, index = 0) => {
        if (!calendarYears.has(next.currentSeason.season_year)) {
          await ensureSyntheticSeasonWeeks(next.admin, next.currentSeason.season_year, 26, 'web actions', resourceOwner)
          calendarYears.add(next.currentSeason.season_year)
        }
        if (new URL(page.url()).origin === new URL(frontend).origin) await page.evaluate(() => localStorage.clear())
        await navigateWebTarget(page, new URL('/sign-in', frontend).href)
        await waitForWebAuthForm(page, 'you@example.com')
        await page.getByPlaceholder('you@example.com').fill(next.users[index].email)
        await page.locator('input[type="password"]').fill(next.password)
        await press(button('Sign In'))
        await page.waitForURL((url) => url.pathname === '/')
        const member = await db(next.admin.from('league_members').select('id').eq('league_id', next.league.id).eq('user_id', next.users[index].id).single())
        await pinWebTargetLeague(target, page, { userId: next.users[index].id, memberId: member.id, leagueName: next.league.name })
      }
      const check = async (name, run) => {
        if (process.env.E2E_WEB_ACTION_CASE && !process.env.E2E_WEB_ACTION_CASE.split(',').includes(name)) return
        const release = await fetch(new URL('/release-provenance.json', frontend)).then((response) => response.json())
        const start = api.length
        const result = { target: target.id, viewport: page.viewportSize(), engine: target.engine, simulatedStandalone: target.standalone, simulatedInsets: target.insets, release: release.commitSha, name, status: 'FAIL', error: null, detail: null, api: [] }
        try { await signIn(fixture); result.detail = await run(); await inspect(); result.status = 'PASS'; await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true }) }
        catch (error) { result.error = error instanceof Error ? error.message : String(error); await page.screenshot({ path: path.join(dir, `${name}-failure.png`) }).catch(() => {}); await writeFile(path.join(dir, `${name}-failure.txt`), await page.locator('body').innerText().catch(() => 'Unavailable')); await writeFile(path.join(dir, `${name}-failure-roles.txt`), await page.locator('body').ariaSnapshot().catch(() => 'Unavailable')) }
        results.push(result)
        result.api = api.slice(start)
        await writeFile(path.join(dir, 'panels.json'), `${JSON.stringify(panels, null, 2)}\n`)
        await writeFile(path.join(artifactDir, 'actions.json'), `${JSON.stringify(results, null, 2)}\n`)
        console.log(JSON.stringify(result))
      }
      try {
        await check('avatar-upload', async () => {
          await open('/profile')
          await wait(async () => await button('Edit').isEnabled())
          const chooser = page.waitForEvent('filechooser')
          await press(button('Change profile photo'))
          const picker = await chooser
          await page.waitForTimeout(100)
          const pickerBusy = await button('Change profile photo').isDisabled()
          await picker.setFiles(path.join(root, 'assets/images/icon.png'))
          let avatar = null
          await wait(async () => { avatar = (await db(fixture.admin.from('profiles').select('avatar_url').eq('id', fixture.users[0].id).single())).avatar_url; return Boolean(avatar) })
          assert.equal(new URL(avatar).hostname, '127.0.0.1')
          assert.equal((await fetch(avatar)).status, 200)
          await reloadWebTarget(page)
          await button('Change profile photo').waitFor()
          assert.equal(pickerBusy, true, 'Photo control must stay busy while its picker is open')
        })
        await check('league-switch-form', async () => {
          const name = `Web pair ${target.id} ${Date.now()}`
          const select = async (name) => {
            await press(button('Switch league'))
            await press(button(`Switch to ${name}`))
            await wait(async () => (await button('Switch league').textContent()).includes(name))
          }
          try {
            await open('/create-league')
            await page.getByRole('textbox', { name: 'League name', exact: true }).fill(name)
            await page.getByRole('textbox', { name: 'Your team name', exact: true }).fill(fixture.proposer.team_name)
            await press(button('Create league'))
            await button('Done').waitFor()
            const league = await db(fixture.admin.from('leagues').select('id').eq('name', name).single())
            extra.registerLeague(league.id)
            await press(button('Done'))
            await open('/profile')
            await select(fixture.league.name)
            await wait(async () => await button('Edit').isEnabled())
            await press(button('Edit'))
            await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Unsaved first league name')
            await select(name)
            assert.equal(new URL(page.url()).pathname, '/profile')
            const shown = await page.getByRole('textbox', { name: 'Team name', exact: true }).inputValue()
            await press(button('Save'))
            await page.getByText('Saved', { exact: true }).first().waitFor()
            const member = await db(fixture.admin.from('league_members').select('team_name').eq('league_id', league.id).eq('user_id', fixture.users[0].id).single())
            assert.equal(member.team_name, fixture.proposer.team_name, 'Switching must not save the former league draft into the selected team')
            assert.equal(shown, fixture.proposer.team_name)
          } finally {
            await open('/profile')
            await select(fixture.league.name)
          }
        })
        await check('analyzer-to-offer', async () => {
          await open('/trades')
          await press(page.getByRole('tab', { name: 'Analyzer', exact: true }))
          await press(button(`Analyze with ${fixture.recipient.team_name}`))
          await press(button(`Select ${fixture.proposerPlayer.display_name} for trade`))
          const sender = page.getByTestId(`trade-sender-${fixture.recipient.id}`)
          if (await sender.isVisible()) await press(sender)
          await press(button(`Select ${fixture.recipientPlayer.display_name} for trade`))
          await button('Make Offer from this analysis').waitFor()
          await wait(async () => await button('Make Offer from this analysis').isEnabled())
          await press(button('Make Offer from this analysis'))
          await press(button('Continue to offer editor'))
          await page.waitForURL((url) => url.pathname === '/propose-trade')
          assert.equal((await db(fixture.admin.from('trades').select('id').eq('league_id', fixture.league.id))).length, 0)
        })
        await check('waiver-edit-reorder-cancel', async () => {
          await db(fixture.admin.from('leagues').update({ waiver_mode: 'faab', faab_starting_budget: 100 }).eq('id', fixture.league.id))
          const balances = await db(fixture.admin.from('faab_balances').select('id').eq('member_id', fixture.proposer.id).eq('league_season_id', fixture.currentSeason.id))
          if (balances.length) await db(fixture.admin.from('faab_balances').update({ balance: 100 }).eq('id', balances[0].id))
          else await db(fixture.admin.from('faab_balances').insert({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id, member_id: fixture.proposer.id, balance: 100 }))
          const players = await findAvailablePlayers(fixture.admin, fixture.league.id, fixture.currentSeason.id, 2, fixture.registerCreatedPlayer, { createOnly: true })
          await db(fixture.admin.from('waiver_wire_log').insert(players.map((player) => ({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id, player_id: player.id, clears_at: new Date(Date.now() + 172800000).toISOString() }))))
          const claims = () => db(fixture.admin.from('waiver_claims').select('id,player_id,status,bid_amount,claim_order').eq('league_id', fixture.league.id).eq('member_id', fixture.proposer.id).order('claim_order').order('submitted_at').order('id'))
          for (const [index, player] of players.entries()) {
            await open(`/claim-player?playerId=${player.id}`)
            await page.getByRole('textbox', { name: 'FAAB bid amount', exact: true }).fill(String(index + 2))
            await press(button('Submit waiver claim'))
            await wait(async () => (await claims()).filter((row) => row.status === 'pending').length === index + 1)
          }
          await open('/roster?claims=1')
          await page.getByRole('textbox', { name: `Bid for ${players[0].display_name}`, exact: true }).fill('9')
          await press(button(`Save bid for ${players[0].display_name}`))
          await wait(async () => (await claims()).find((row) => row.player_id === players[0].id)?.bid_amount === 9)
          await page.getByRole('textbox', { name: `Bid for ${players[1].display_name}`, exact: true }).fill('9')
          await press(button(`Save bid for ${players[1].display_name}`))
          await wait(async () => (await claims()).find((row) => row.player_id === players[1].id)?.bid_amount === 9)
          await press(button(`Move ${players[1].display_name} claim up`))
          await wait(async () => (await claims()).filter((row) => row.status === 'pending')[0]?.player_id === players[1].id)
          for (const player of players) { await press(button(`Cancel claim for ${player.display_name}`)); await wait(async () => (await claims()).find((row) => row.player_id === player.id)?.status === 'cancelled') }
        })
        await auditWebDraftActions({ check, env, season, page, press, button, open, signIn, db, wait, inspect })
        await auditWebCommissionerActions({ check, env, season, page, press, button, open, signIn, db, wait, inspect })
        await auditWebPlayerActions({ check, env, season, target, page, press, button, open, signIn, db, wait, inspect })
        await auditWebPanelActions({ check, env, season, target, page, press, button, open, signIn, db, wait, inspect })
        await auditWebInviteActions({ check, env, season, page, press, button, open, signIn, db, wait })
        await auditWebMockActions({ check, env, season, page, press, button, open, signIn, db, wait, inspect })
        await auditWebAuthActions({ check, env, season, page, press, button, open, db, wait })
        await auditWebNotificationActions({ check, env, season, target, page, press, button, open, signIn, db, wait })
      } finally {
        await context.close()
        await browser.close()
        await fixture.admin.storage.from('avatars').remove([`${fixture.users[0].id}/avatar.png`])
        await extra.dispose()
        await fixture.dispose()
      }
    })
  }
  assert.ok(results.length, 'Action filters must select a case and target')
  const report = { serviceWorkers: 'blocked for action request gates; checked separately by the default matrix', status: results.every((result) => result.status === 'PASS') ? 'PASS' : 'FAIL', targets: results, artifactDir, season }
  await writeFile(path.join(artifactDir, 'actions.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(path.join(artifactDir, 'actions.md'), ['# Web actions', '', 'Playwright emulation. Permission and delivery simulations are identified per case.', '', '| Target | Action | Result |', '| --- | --- | --- |', ...results.map((row) => `| ${row.target} | ${row.name} | ${row.status} |`), ''].join('\n'))
  return report
}
