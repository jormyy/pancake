import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { createBrowser, fillSignInCredentials, clickButtonByName, listBrowserSessions, openCdpClient, selectCdpPageTarget } from './browser-agent.mjs'

const keys = Object.fromEntries(execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').flatMap(line => {
  const match = /^([A-Z_]+)="(.*)"$/.exec(line)
  return match ? [[match[1], match[2]]] : []
}))
const target = new URL(keys.API_URL)
assert(['127.0.0.1', 'localhost'].includes(target.hostname) && target.port === '57921')
const origin = 'http://127.0.0.1:57980'
const admin = createClient(keys.API_URL, keys.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const browser = createBrowser()
const session = `draft-timer-${process.pid}`
const root = resolve('evidence/screenshots')
await mkdir(root, { recursive: true })
console.log(await listBrowserSessions())
const suffix = randomUUID().replaceAll('-', '')
const password = `Synthetic-${randomUUID()}!`
const users = []
const league = randomUUID(), season = randomUUID(), openingGame = randomUUID()
let client
const evaluate = async source => {
  const output = await browser(session, ['eval', source])
  const value = JSON.parse(output.trim().split('\n').at(-1))
  return typeof value === 'string' ? JSON.parse(value) : value
}
const clickRole = async (role, label) => {
  for (let attempt = 0; attempt < 30; attempt++) {
    const snapshot = await browser(session, ['snapshot'])
    const line = snapshot.split('\n').find(line => line.includes(`${role} "${label}"`))
    const ref = line?.match(/ref=([^\],]+)/)?.[1]
    if (ref) { await browser(session, ['click', ref]); return }
    await browser(session, ['wait', '250'])
  }
  throw Error(`Missing ${role}: ${label}`)
}
const insert = async (table, rows) => {
  const result = await admin.from(table).insert(rows)
  if (result.error) throw result.error
}
await runWithScenarioResourceOwner('draft timer UI', async () => {
try {
  for (let n = 0; n < 2; n++) {
    const email = `timer-${n}-${suffix}@example.test`
    const result = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `timer${n}${suffix.slice(0,12)}`, display_name: `Timer ${n}` } })
    if (result.error) throw result.error
    users.push({ id: result.data.user.id, email })
  }
  const members = [randomUUID(), randomUUID()]
  await insert('leagues', { id: league, name: 'Timer preview', slug: suffix, commissioner_id: users[0].id, status: 'offseason', playoff_entrants: 2, playoff_round_lengths: [1] })
  await insert('league_seasons', { id: season, league_id: league, season_year: 2189, is_current: true })
  await insert('league_members', members.map((id, n) => ({ id, league_id: league, user_id: users[n].id, role: n === 0 ? 'commissioner' : 'manager', team_name: `Timer team ${n}` })))
  await insert('draft_picks', members.flatMap(id => [1,2,3].map(round => ({ league_id: league, season_year: 2189, round, original_owner_id: id, current_owner_id: id }))))
  await browser(session, ['open', origin])
  await fillSignInCredentials(browser, session, users[0].email, password)
  await clickButtonByName(browser, session, 'Sign In')
  await browser(session, ['wait', '2000'])
  const endpoint = (await browser(session, ['get', 'cdp-url'])).match(/ws:\/\/\S+/)?.[0]
  assert(endpoint)
  client = await openCdpClient(endpoint)
  const { targetInfos } = await client.send('Target.getTargets')
  const page = selectCdpPageTarget(targetInfos)
  assert(page)
  const { sessionId } = await client.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  await client.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' }, sessionId)
  const reports = []
  for (const viewport of [{ name: 'iphone', width: 393, height: 852, dpr: 3, top: 59, bottom: 34 }, { name: 'desktop', width: 1440, height: 900, dpr: 1, top: 0, bottom: 0 }]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.dpr, mobile: viewport.name === 'iphone' }, sessionId)
    await client.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: viewport.top, bottom: viewport.bottom, left: 0, right: 0 } }, sessionId)
    await browser(session, ['open', `${origin}/league?tab=settings`])
    await browser(session, ['wait', '1000'])
    let taps = 0
    await clickRole('tab', 'Draft Board'); taps++
    await browser(session, ['wait', '500'])
    await clickRole('radio', '604800 seconds'); taps++
    await browser(session, ['wait', '500'])
    const selected = await evaluate(`(() => { const radio = document.querySelector('[role="radio"][aria-label="604800 seconds"]'); return JSON.stringify({ selected: radio?.getAttribute('aria-checked'), width: innerWidth, scrollWidth: document.documentElement.scrollWidth, height: innerHeight }); })()`)
    assert.equal(selected.selected, 'true')
    assert(selected.scrollWidth <= selected.width, 'No page-wide horizontal scroll')
    await browser(session, ['scroll', 'up', '2000'])
    await browser(session, ['wait', '250'])
    await browser(session, ['screenshot', resolve(root, `${viewport.name}-timer.png`)])
    const custom = (await browser(session, ['snapshot'])).split('\n').find(line => line.includes('textbox "Custom pick duration"'))?.match(/ref=([^\],]+)/)?.[1]
    assert(custom)
    await browser(session, ['fill', custom, '0'])
    await browser(session, ['press', 'Tab'])
    const invalid = await browser(session, ['snapshot'])
    assert(invalid.includes('Enter 1 minute through 7 days.'))
    assert.equal((await evaluate(`JSON.stringify({disabled: document.querySelector('[aria-label^="Start rookie draft,"]')?.getAttribute('aria-disabled')})`)).disabled, 'true')
    await clickRole('radio', 'Days')
    const dayCustom = (await browser(session, ['snapshot'])).split('\n').find(line => line.includes('textbox "Custom pick duration"'))?.match(/ref=([^\],]+)/)?.[1]
    assert(dayCustom)
    await browser(session, ['fill', dayCustom, '8'])
    await browser(session, ['press', 'Tab'])
    assert((await browser(session, ['snapshot'])).includes('Enter 1 minute through 7 days.'))
    await browser(session, ['fill', dayCustom, '7'])
    await browser(session, ['press', 'Tab'])
    await clickRole('radio', '604800 seconds')
    const startSnapshot = await browser(session, ['snapshot'])
    const start = startSnapshot.split('\n').find(line => line.includes('button "Start rookie draft,'))?.match(/ref=([^\],]+)/)?.[1]
    assert(start)
    await browser(session, ['click', start])
    await browser(session, ['wait', '500'])
    const warningSnapshot = await browser(session, ['snapshot'])
    assert(warningSnapshot.includes('Opening night is not published yet.'))
    await browser(session, ['screenshot', resolve(root, `${viewport.name}-warning.png`)])
    await clickButtonByName(browser, session, 'Cancel')
    await insert('nba_games', { id: openingGame, season_year: 2189, nba_game_id: '0028900035', game_date: new Date(Date.now()+86400000).toISOString().slice(0,10), week_number: 1, home_team: 'BOS', away_team: 'NYK', status: 'Scheduled' })
    const publishedStart = (await browser(session, ['snapshot'])).split('\n').find(line => line.includes('button "Start rookie draft,'))?.match(/ref=([^\],]+)/)?.[1]
    assert(publishedStart)
    await browser(session, ['click', publishedStart])
    await browser(session, ['wait', '500'])
    assert((await browser(session, ['snapshot'])).includes('could run past opening night'))
    await browser(session, ['screenshot', resolve(root, `${viewport.name}-overrun-warning.png`)])
    await clickButtonByName(browser, session, 'Cancel')
    await admin.from('nba_games').delete().eq('id', openingGame)
    reports.push({ viewport, tapsFromLeagueSettings: taps, selected, invalidRangeRejected: true, warningBeforeConfirmation: true, publishedOverrunWarning: true })
  }
  await writeFile(resolve('evidence/ui-report.json'), JSON.stringify({ provenance: 'SYNTHETIC', browser: 'Chrome for Testing; native iOS Safari is not verified', reports }, null, 2))
  console.log(JSON.stringify(reports))
} catch (error) {
  await browser(session, ['screenshot', resolve(root, 'failure.png')]).catch(() => {})
  await writeFile(resolve('evidence/ui-failure-snapshot.txt'), await browser(session, ['snapshot']).catch(String))
  throw error
} finally {
  client?.close()
  await browser(session, ['close']).catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 500))
  console.log(await listBrowserSessions())
  await admin.from('nba_games').delete().eq('id', openingGame)
  const removed = await admin.from('leagues').delete().eq('id', league)
  if (removed.error) console.error(removed.error.message)
  for (const user of users) await admin.auth.admin.deleteUser(user.id)
}

})
