import { navigateWebTarget, waitForWebAuthForm } from './web-targets-browser.mjs'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { setupTradeGameplayFixture, createFixtureResourceOwner } from './trade-fixture.mjs'

export async function auditWebAuthActions({ check, env, season, page, press, button, open, signIn, db, wait }) {
  await check('session-refresh-switch-and-reopen', async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    await signIn(fixture)
    const key = `sb-${new URL(env.supabaseUrl).hostname.split('.')[0]}-auth-token`
    const prior = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)
    assert.equal(prior.user.id, fixture.users[0].id)
    await page.addInitScript(() => {
      const expiredAt = Number(sessionStorage.getItem('functional-refresh-clock'))
      if (!expiredAt) return
      const now = Date.now
      const fetch = window.fetch.bind(window)
      Date.now = () => expiredAt
      window.fetch = (input, init) => {
        const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        if (url.includes('/auth/v1/token') && url.includes('grant_type=refresh_token')) {
          Date.now = now
          sessionStorage.removeItem('functional-refresh-clock')
          window.fetch = fetch
        }
        return fetch(input, init)
      }
    })
    await page.evaluate(at => sessionStorage.setItem('functional-refresh-clock', String(at)), prior.expires_at * 1000 + 1000)
    const refresh = page.waitForResponse(response => response.url().includes('grant_type=refresh_token') && response.request().method() === 'POST')
    await page.reload()
    assert.equal((await refresh).status(), 200)
    await page.getByRole('navigation', { name: 'Primary', exact: true }).waitFor()
    const renewed = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)
    assert.equal(renewed.user.id, fixture.users[0].id)
    assert.notEqual(renewed.refresh_token, prior.refresh_token)
    await open('/profile')
    await press(button('Sign out'))
    await press(page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }))
    await page.getByPlaceholder('you@example.com').waitFor()
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null)
    await signIn(fixture, 1)
    await open('/profile')
    await page.getByText(fixture.recipient.team_name, { exact: true }).first().waitFor()
    assert.equal((await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)).user.id, fixture.users[1].id)
    await page.goto('about:blank')
    await navigateWebTarget(page, new URL('/profile', env.frontendUrl).href)
    await page.getByText(fixture.recipient.team_name, { exact: true }).first().waitFor()
    assert.equal((await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)).user.id, fixture.users[1].id)
    return { refreshedThroughAuthServer: true, refreshTokenRotated: true, signedOut: true, switchedAccount: true, reopenedWithSecondAccount: true,
      simulation: 'The client clock marks a valid saved token expired. The clock resets before the real refresh request. Server expiry timing is not simulated or claimed.' }
  })
  await check('signup-password-signout', async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    const resources = createFixtureResourceOwner(fixture.admin)
    const username = `web_${Date.now()}_${Math.floor(Math.random() * 100000)}`
    const email = `${username}@example.com`
    const password = 'LocalWebSignup123!'
    const nextPassword = 'LocalWebChanged456!'
    await page.evaluate(() => localStorage.clear())
    await navigateWebTarget(page, new URL('/sign-up', env.frontendUrl).href)
    await waitForWebAuthForm(page, 'Maple Manager')
    await page.getByPlaceholder('Maple Manager').fill('Web Action Manager')
    await page.getByPlaceholder('hoopsgod').fill(username)
    await page.getByPlaceholder('you@example.com').fill(email)
    await page.getByPlaceholder('Minimum 8 characters').fill(password)
    let submits = 0
    const count = (request) => { if (request.url().includes('/auth/v1/signup') && request.method() === 'POST') submits += 1 }
    page.on('request', count)
    try {
      const response = page.waitForResponse((response) => response.url().includes('/auth/v1/signup') && response.request().method() === 'POST')
      await page.getByPlaceholder('Minimum 8 characters').focus()
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      const receipt = await response
      assert.equal(receipt.status(), 200)
      const payload = await receipt.json()
      const id = payload.user?.id ?? payload.id
      assert.ok(id)
      resources.registerUser(id)
      await page.getByRole('navigation', { name: 'Primary', exact: true }).waitFor()
      assert.equal(submits, 1)
      const profile = await db(fixture.admin.from('profiles').select('username,display_name').eq('id', id).single())
      assert.deepEqual(profile, { username, display_name: 'Web Action Manager' })
      await open('/profile')
      await press(button('Change password'))
      const current = page.getByLabel('Current password', { exact: true })
      await current.fill('WrongLocalPassword')
      await page.getByLabel('New password', { exact: true }).fill(nextPassword)
      await page.getByLabel('Confirm new password', { exact: true }).fill(nextPassword)
      await press(button('Update password'))
      await page.getByText('Your current password is incorrect.', { exact: true }).waitFor()
      await current.fill(password)
      await page.getByLabel('Confirm new password', { exact: true }).focus()
      await page.keyboard.press('Enter')
      await page.waitForURL((url) => url.pathname === '/profile')
      const auth = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
      assert.ok((await auth.auth.signInWithPassword({ email, password })).error)
      assert.equal((await auth.auth.signInWithPassword({ email, password: nextPassword })).error, null)
      await auth.auth.signOut({ scope: 'local' })
      await press(button('Sign out'))
      await press(page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }))
      await page.getByPlaceholder('you@example.com').waitFor()
      await page.getByPlaceholder('you@example.com').fill(email)
      await page.locator('input[type="password"]').fill(nextPassword)
      await press(button('Sign In'))
      await wait(async () => new URL(page.url()).pathname === '/')
      return { signedUp: true, returnSubmits: submits, passwordChanged: true, oldPasswordRejected: true, signedOut: true, signedInWithNewPassword: true }
    } finally { page.off('request', count) }
  })
}
