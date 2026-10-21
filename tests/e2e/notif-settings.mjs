import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { createBrowser, listBrowserSessions, openCdpClient, selectCdpPageTarget } from './browser-agent.mjs'

const api = process.env.SUPABASE_URL
const secret = process.env.PANCAKE_SUPABASE_SECRET_KEY
const evidence = process.env.NOTIF_EVIDENCE
const origin = 'http://127.0.0.1:57880'
assert.ok(['127.0.0.1','localhost'].includes(new URL(api).hostname) && new URL(api).port === '57821')
assert.ok(path.isAbsolute(evidence) && !evidence.startsWith(`${process.cwd()}/`))
const admin = createClient(api, secret, { auth: { persistSession: false, autoRefreshToken: false } })
const email = `notif-${randomUUID()}@example.test`
const password = `Synthetic-${randomUUID()}`
const browser = createBrowser({ cwd: process.cwd() })
const session = `notif-settings-${process.pid}`
let userId
let emulationClient
const parse = (value) => {
    const result = JSON.parse(value.split('\n').filter(Boolean).at(-1))
    return typeof result === 'string' ? JSON.parse(result) : result
}
async function waitFor(selector) {
    await browser(session, ['wait',selector], { timeout: 10000 })
}
async function click(label, role = 'button') {
    await browser(session, ['snapshot','-i'])
    await browser(session, ['find','role',role,'click','--name',label,'--exact'])
}
async function emulation(width, height, mobile) {
    const endpoint = (await browser(session, ['get','cdp-url'])).match(/ws:\/\/\S+/)?.[0]
    assert.ok(endpoint)
    emulationClient?.close()
    const cdp = await openCdpClient(endpoint)
    emulationClient = cdp
    try {
        const { targetInfos } = await cdp.send('Target.getTargets')
        const target = targetInfos.find(item => item.type === 'page' && item.url.startsWith(origin)) ?? selectCdpPageTarget(targetInfos)
        assert.ok(target)
        const attached = await cdp.send('Target.attachToTarget',{ targetId: target.targetId, flatten: true })
        await cdp.send('Emulation.setDeviceMetricsOverride',{ width,height,deviceScaleFactor: mobile ? 3 : 1,mobile },attached.sessionId)
        await cdp.send('Emulation.setSafeAreaInsetsOverride',{ insets: { top: mobile ? 59 : 0,bottom: mobile ? 34 : 0,left: 0,right: 0 } },attached.sessionId)
        await cdp.send('Runtime.evaluate',{ expression: 'window.dispatchEvent(new Event("resize"))' },attached.sessionId)
    } catch (error) { cdp.close(); throw error }
}
await runWithScenarioResourceOwner('notification settings', async () => {
try {
    await listBrowserSessions({ cwd: process.cwd() })
    const created = await admin.auth.admin.createUser({ email,password,email_confirm: true,user_metadata: { username: `notif${randomUUID().replaceAll('-','').slice(0,12)}`,display_name: 'Notification Test' } })
    assert.equal(created.error,null)
    userId = created.data.user.id
    await mkdir(path.join(evidence,'screenshots'),{ recursive: true })
    const publicClient = createClient(api, process.env.NOTIF_PUBLIC_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const signedIn = await publicClient.auth.signInWithPassword({ email,password })
    assert.equal(signedIn.error,null)
    const issuer = JSON.parse(Buffer.from(signedIn.data.session.access_token.split('.')[1], 'base64url').toString()).iss
    assert.equal(issuer,`${api}/auth/v1`)
    await browser(session,['open',`${origin}/sign-in`])
    await browser(session,['eval',`localStorage.setItem('sb-${new URL(api).hostname.split('.')[0]}-auth-token',${JSON.stringify(JSON.stringify(signedIn.data.session))}); true`])
    console.log('Synthetic session installed')
    const report = []
    for (const { name,width,height,mobile } of [{ name: 'iphone',width: 393,height: 852,mobile: true },{ name: 'desktop',width: 1440,height: 900,mobile: false }]) {
        console.log('Checking '+name)
        await emulation(width,height,mobile)
        console.log(await browser(session,['eval','JSON.stringify({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})']))
        await browser(session,['open',`${origin}/profile`])
        await waitFor('[aria-label="Notification settings"]')
        let taps = 0
        await click('Notification settings'); taps++
        await waitFor('[aria-label="Trades: New offer"]:not([aria-disabled="true"])')
        await click('Trades: New offer','switch'); taps++
        await browser(session,['wait','350'])
        const eventChoice = await admin.from('notification_preferences').select('event_settings').eq('user_id',userId).single()
        assert.equal(eventChoice.error,null)
        assert.equal(eventChoice.data.event_settings.trade_offered,false)
        report.push({ viewport: name,task: 'Turn one trade notification off from main settings',taps })
        await click('Trades: New offer','switch')
        await browser(session,['wait','350'])
        await browser(session,['open',`${origin}/profile`])
        await waitFor('[aria-label="Notification settings"]')
        taps = 0
        await click('Notification settings'); taps++
        await waitFor('[aria-label="All trades notifications"]:not([aria-disabled="true"])')
        await click('All trades notifications','switch'); taps++
        await browser(session,['wait','350'])
        const categoryChoice = await admin.from('notification_preferences').select('category_settings,trade_enabled').eq('user_id',userId).single()
        assert.equal(categoryChoice.error,null)
        assert.equal(categoryChoice.data.trade_enabled,false)
        assert.equal(categoryChoice.data.category_settings.trade,false)
        report.push({ viewport: name,task: 'Turn the trades category off from main settings',taps })
        await click('All trades notifications','switch')
        await browser(session,['wait','350'])
        console.log('Tap tasks passed for '+name)
        await browser(session,['screenshot',path.join(evidence,'screenshots',`${name}-expanded.png`)],{ timeout: 60000 })
        await click('Collapse all')
        await browser(session,['wait','200'])
        const geometry = parse(await browser(session,['eval',`JSON.stringify({ width: innerWidth,height: innerHeight,dpr: devicePixelRatio,scrollWidth: document.documentElement.scrollWidth,buttons: [...document.querySelectorAll('[aria-label="All notifications"],[aria-label="All league notifications"]')].map(el => { const r=el.getBoundingClientRect(); return { label: el.getAttribute('aria-label'),x:r.x,y:r.y,width:r.width,height:r.height }; }),safeArea: (() => { const probe=document.createElement('div'); probe.style.paddingTop='env(safe-area-inset-top)'; probe.style.paddingBottom='env(safe-area-inset-bottom)'; document.body.appendChild(probe); const style=getComputedStyle(probe); const result={top:parseFloat(style.paddingTop),bottom:parseFloat(style.paddingBottom)}; probe.remove(); return result; })() })`]))
        assert.ok(geometry.scrollWidth <= width, 'Horizontal overflow')
        assert.equal(geometry.width,width)
        assert.equal(geometry.dpr,mobile ? 3 : 1)
        assert.deepEqual(geometry.safeArea,{ top: mobile ? 59 : 0,bottom: mobile ? 34 : 0 })
        assert.ok(geometry.buttons.every((button) => button.x >= 0 && button.x+button.width <= width))
        report.push({ viewport: name,geometry })
        await browser(session,['screenshot',path.join(evidence,'screenshots',`${name}-collapsed.png`)],{ timeout: 60000 })
        await browser(session,['scrollintoview','[aria-label="All league notifications"]'])
        const lastRow = parse(await browser(session,['eval',`(() => { const r=document.querySelector('[aria-label="All league notifications"]').getBoundingClientRect(); return JSON.stringify({top:r.top,bottom:r.bottom}); })()`]))
        assert.ok(lastRow.top >= (mobile ? 115 : 0) && lastRow.bottom <= height-(mobile ? 98 : 0), 'Last category cannot scroll above the home indicator')
        report.push({ viewport: name,lastCategory: lastRow })
        await browser(session,['focus','[aria-label="All league notifications"]'])
        await browser(session,['press','Enter'])
        await browser(session,['wait','350'])
        const keyboardChoice = await admin.from('notification_preferences').select('category_settings').eq('user_id',userId).single()
        assert.equal(keyboardChoice.error,null)
        assert.equal(keyboardChoice.data.category_settings.league,false)
        await browser(session,['press','Enter'])
        await browser(session,['wait','350'])
        report.push({ viewport: name,lastCategoryKeyboard: 'Enter toggles the focused category' })

    }
    await writeFile(path.join(evidence,'tap-counts.json'),JSON.stringify({ provenance: 'SYNTHETIC',browser: 'Headless Chrome for Testing',safeArea: { top:59,bottom:34 },report },null,2))
    await writeFile(path.join(evidence,'browser-console.log'),await browser(session,['console']))
    const errors = await browser(session,['errors'])
    await writeFile(path.join(evidence,'browser-errors.log'),errors)
    assert.ok(!errors.trim(),errors)
    console.log(JSON.stringify({ tasks:report,screenshots:4 }))
} catch (error) {
    await writeFile(path.join(evidence,'browser-failure.snapshot.txt'),await browser(session,['snapshot']).catch(() => 'Snapshot unavailable'))
    throw error
} finally {
    emulationClient?.close()
    await browser(session,['close']).catch(() => {})
    await listBrowserSessions({ cwd: process.cwd() })
    if (userId) await admin.auth.admin.deleteUser(userId)
}
})
