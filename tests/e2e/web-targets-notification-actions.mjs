import assert from 'node:assert/strict'
import { setupTradeGameplayFixture } from './trade-fixture.mjs'

export async function auditWebNotificationActions({ check, env, season, target, page, press, button, open, signIn, db, wait }) {
  await check('notification-local-capabilities', async () => {
    await open('/profile')
    const expected = await page.evaluate(() => {
      if (!('PushManager' in window) || !('Notification' in window)) return /iPhone/.test(navigator.userAgent) && !Reflect.get(navigator, 'standalone') ? 'install' : 'unsupported'
      return Notification.permission === 'denied' ? 'denied' : 'unconfigured'
    })
    const copy = { install: /To get notifications on iPhone/, unsupported: 'This browser does not support push notifications.',
      denied: /Notifications are blocked/, unconfigured: 'Push notifications are not available yet.' }
    await page.getByText(copy[expected], { exact: typeof copy[expected] === 'string' }).waitFor()
    assert.equal(await button('Test').count(), 0)
    return { target: target.id, capability: expected, actualDelivery: 'Not exercised. The local server has no VAPID keys.' }
  })
  await check('notification-simulated-permission-and-preferences', async () => {
    const fixture = await setupTradeGameplayFixture(env, season, { isolatedPlayers: true, includeFuturePicks: false })
    const key = Buffer.alloc(65, 1).toString('base64url')
    const calls = []
    let generation = 0
    const pattern = '**/api/profile/web-push/*'
    await page.context().route(pattern, async (route) => {
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,OPTIONS' }
      if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return }
      const action = new URL(route.request().url()).pathname.split('/').pop()
      calls.push(action)
      const response = action === 'config' ? { publicKey: key } : action === 'test' ? { sent: 0, pruned: 0, failed: 0 }
        : { applied: true, generation: ++generation, revocationCredential: 'a'.repeat(43) }
      await route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(response) })
    })
    await page.addInitScript(() => {
      const state = { permission: 'default', response: 'default', prompts: 0, subscription: null, sequence: 0 }
      Reflect.set(window, '__webPushSimulation', state)
      class SimulatedNotification {
        static get permission() { return state.permission }
        static async requestPermission() { state.prompts += 1; state.permission = state.response; return state.response }
      }
      Object.defineProperty(window, 'Notification', { configurable: true, value: SimulatedNotification })
      Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} })
      const worker = { pushManager: {
        getSubscription: async () => state.subscription,
        subscribe: async () => {
          const endpoint = `https://push.example.invalid/web-target-${++state.sequence}`
          state.subscription = { endpoint, options: {}, toJSON: () => ({ endpoint, keys: { p256dh: 'simulated', auth: 'simulated' } }),
            unsubscribe: async () => { state.subscription = null; return true } }
          return state.subscription
        },
      } }
      Object.defineProperty(navigator.serviceWorker, 'getRegistration', { configurable: true, value: async () => worker })
      Object.defineProperty(navigator.serviceWorker, 'ready', { configurable: true, value: Promise.resolve(worker) })
    })
    try {
      await signIn(fixture)
      await open('/profile')
      await button('Turn on').waitFor()
      await press(button('Turn on'))
      await wait(async () => await button('Turn on').isEnabled())
      assert.equal(await page.evaluate(() => Reflect.get(window, '__webPushSimulation').prompts), 1)
      await page.evaluate(() => { Reflect.get(window, '__webPushSimulation').response = 'denied' })
      await press(button('Turn on'))
      await page.getByText(/Notifications are blocked/).waitFor()
      await page.reload()
      await button('Turn on').waitFor()
      await page.evaluate(() => { Reflect.get(window, '__webPushSimulation').response = 'granted' })
      await press(button('Turn on'))
      await button('Turn off').waitFor()
      for (const [label, column] of [['Trades', 'trade_enabled'], ['Waivers', 'waiver_enabled'], ['Drafts', 'draft_enabled'], ['League activity', 'activity_enabled']]) {
        const toggle = page.getByRole('switch', { name: label, exact: true })
        await press(toggle)
        await wait(async () => (await db(fixture.admin.from('notification_preferences').select(column).eq('user_id', fixture.users[0].id).single()))[column] === false)
        assert.equal(await toggle.isChecked(), false)
        await press(toggle)
        await wait(async () => (await db(fixture.admin.from('notification_preferences').select(column).eq('user_id', fixture.users[0].id).single()))[column] === true)
      }
      await press(button('Test'))
      await page.getByText('No notification sent', { exact: true }).waitFor()
      await press(button('Dismiss').last())
      await press(button('Turn off'))
      await button('Turn on').waitFor()
      assert.equal(await page.getByRole('switch', { name: 'Trades', exact: true }).count(), 0)
      for (const action of ['config', 'subscribe', 'test', 'unsubscribe']) assert.ok(calls.includes(action), action)
      return { simulated: ['permission default', 'permission denied', 'permission granted', 'subscription', 'empty test delivery', 'unsubscribe'],
        actualDatabaseWrites: 'Four notification categories off and on', realDeviceRequired: ['Home Screen installation', 'iOS permission prompt', 'push delivery', 'background notification tap'] }
    } finally { await page.context().unroute(pattern) }
  })
}
