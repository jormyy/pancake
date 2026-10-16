import assert from 'node:assert/strict'
import { setupTradeGameplayFixture, createFixtureResourceOwner } from './trade-fixture.mjs'

export async function auditWebInviteActions({ check, env, season, page, press, button, open, signIn, db, wait }) {
  await check('invite-sharing-fallback-cancel-and-retry', async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    const resources = createFixtureResourceOwner(fixture.admin)
    const errors = []
    const onError = (error) => errors.push(error.message)
    page.on('pageerror', onError)
    const results = []
    await signIn(fixture)
    try {
      for (const flow of ['settings', 'create']) {
        let code = fixture.league.invite_code
        if (flow === 'settings') await open('/league?tab=settings')
        else {
          await open('/create-league')
          const name = `Share ${fixture.runId}`
          await page.getByRole('textbox', { name: 'League name', exact: true }).fill(name)
          await page.getByRole('textbox', { name: 'Your team name', exact: true }).fill('Share team')
          await press(button('Create league'))
          await button('Done').waitFor()
          const league = await db(fixture.admin.from('leagues').select('id,invite_code').eq('name', name).single())
          resources.registerLeague(league.id)
          code = league.invite_code
        }
        const nativeShareAvailable = await page.evaluate(() => typeof navigator.share === 'function')
        await page.evaluate(() => {
          Reflect.set(window, '__inviteCopies', [])
          Reflect.set(window, '__inviteShares', [])
          Reflect.set(window, '__pancakeAlerts', [])
          Reflect.set(window, '__inviteClipboardMode', 'hold')
          Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => {
            Reflect.get(window, '__inviteCopies').push(text)
            const mode = Reflect.get(window, '__inviteClipboardMode')
            if (mode === 'deny') throw new DOMException('Clipboard denied', 'NotAllowedError')
            if (mode === 'hold') await new Promise((resolve) => Reflect.set(window, '__releaseInviteClipboard', resolve))
          } } })
        })
        const share = () => flow === 'settings' ? button(`Share invite code ${code}`) : button('Share invite code')
        try {
          await press(share())
          assert.deepEqual(errors, [], 'Sharing must handle browser API failures')
          await wait(async () => await page.evaluate(() => Reflect.get(window, '__inviteCopies').length === 1))
          await press(share())
          assert.equal(await page.evaluate(() => Reflect.get(window, '__inviteCopies').length), 1)
        } finally {
          await page.evaluate(() => Reflect.get(window, '__releaseInviteClipboard')?.())
        }
        await page.getByText('Invite message copied.', { exact: true }).last().waitFor()
        assert.ok((await page.evaluate(() => Reflect.get(window, '__inviteCopies')[0])).includes(code))
        await page.evaluate(() => Reflect.set(window, '__inviteClipboardMode', 'deny'))
        await press(share())
        await page.getByText('Could not share invite', { exact: true }).last().waitFor()
        await press(button('Dismiss').last())
        await page.evaluate(() => Reflect.set(window, '__inviteClipboardMode', 'write'))
        await press(share())
        await wait(async () => await page.evaluate(() => Reflect.get(window, '__inviteCopies').length === 3))
        await page.getByText('Invite message copied.', { exact: true }).last().waitFor()
        await page.evaluate(() => {
          Reflect.set(window, '__inviteNativeMode', 'cancel')
          Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => {
            Reflect.get(window, '__inviteShares').push(data.text)
            const mode = Reflect.get(window, '__inviteNativeMode')
            if (mode === 'cancel') throw new DOMException('Share cancelled', 'AbortError')
            if (mode === 'deny') throw new DOMException('Share denied', 'NotAllowedError')
          } })
        })
        const notices = await page.evaluate(() => Reflect.get(window, '__pancakeAlerts').length)
        await press(share())
        await wait(async () => await page.evaluate(() => Reflect.get(window, '__inviteShares').length === 1))
        assert.equal(await page.evaluate(() => Reflect.get(window, '__pancakeAlerts').length), notices)
        await page.evaluate(() => Reflect.set(window, '__inviteNativeMode', 'deny'))
        await press(share())
        await page.getByText('Could not share invite', { exact: true }).last().waitFor()
        await press(button('Dismiss').last())
        await page.evaluate(() => Reflect.set(window, '__inviteNativeMode', 'success'))
        await press(share())
        await wait(async () => await page.evaluate(() => Reflect.get(window, '__inviteShares').length === 3))
        assert.ok((await page.evaluate(() => Reflect.get(window, '__inviteShares').at(-1))).includes(code))
        assert.equal(await page.evaluate(() => Reflect.get(window, '__inviteCopies').length), 3)
        assert.deepEqual(errors, [])
        results.push({ flow, nativeShareAvailable, clipboardAttempts: 3, nativeAttempts: 3, duplicatePendingCopies: 0, unhandledErrors: 0,
          simulation: 'Browser capability, clipboard permission, and share dialog results are simulated. Real UI handlers and saved invite codes are used.' })
      }
      return results
    } finally { page.off('pageerror', onError) }
  })
}
