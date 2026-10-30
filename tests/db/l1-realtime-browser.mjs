import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'
import { createBrowser } from '../e2e/browser-agent.mjs'
import { runWithScenarioResourceOwner } from '../e2e/scenario-resource-owner.mjs'
import { localKeys, sql } from '../../scripts/perf-lab/database.mjs'
import { requireMini, project } from '../../scripts/perf-lab/common.mjs'
import { setupRequest } from './l1-realtime-setup-retry.mjs'

await requireMini()
assert.equal(project, 'pt4bafablel1')
process.env.E2E_BROWSER_SCREENSHOT_MODE = 'agent'
const root = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-l1')
const { origin, active } = JSON.parse(await readFile(path.join(root, 'runtime-ready.json'), 'utf8'))
assert.equal(active, 'broadcast')
assert.equal(new URL(origin).port, '62284')
assert.ok(new URL(origin).hostname.endsWith('.local'))
const legacyOrigin = process.argv[2]
const legacyVersion = process.argv[3] ?? '2.9.1'
const released = {
  '2.9.1': '04177a1b8f25f4eb0b72f93591ce2967ab00a78c',
  '2.10.2': '892b6bcabb06c8a2b99d12e58ae13d86355afb8e',
  '2.11': '1e696f2506b0204cc4e744981e572c6d7964f660',
  '2.11.1': '952580ce3204598d1fd120b3f121d166c7626028',
}
assert.ok(Object.hasOwn(released, legacyVersion))
if (legacyOrigin) {
  assert.equal(new URL(legacyOrigin).hostname, new URL(origin).hostname)
  assert.equal(new URL(legacyOrigin).protocol, 'https:')
  assert.equal(new URL(legacyOrigin).port, '62285')
}
const keys = await localKeys()
const scores = JSON.parse(await readFile(path.join(root, 'evidence/score-fixture.json'), 'utf8'))
const fixture = JSON.parse(await sql(`SELECT json_build_object(
  'matchup',(SELECT row_to_json(m) FROM (SELECT id,home_member_id,away_member_id,home_points FROM public.matchups WHERE id='${scores[0].id}') m),
  'members',(SELECT json_agg(m) FROM (SELECT member.id,member.league_id,member.user_id,member.team_name,user_row.email FROM public.league_members member
    JOIN auth.users user_row ON user_row.id=member.user_id WHERE member.id IN (SELECT unnest(ARRAY[home_member_id,away_member_id]) FROM public.matchups WHERE id='${scores[0].id}') ORDER BY member.id) m))`))
assert.equal(fixture.members.length, 2)
const password = randomBytes(32).toString('hex')
const run = `fable-l1-${Date.now()}`
const sessions = []
const setupRetries = []
const browser = createBrowser({ cwd: process.cwd(), defaultTimeout: 60000 })
const parse = output => {
  const value = JSON.parse(output.trim().split('\n').at(-1))
  return typeof value === 'string' ? JSON.parse(value) : value
}
const evaluate = async (name, code) => parse(await browser(name, ['eval', code]))
const body = name => evaluate(name, 'JSON.stringify({text:document.body.innerText,path:location.pathname,joins:window.__l1Joins??null})')
const waitFor = async (name, predicate) => {
  let last
  for (let attempt = 0; attempt < 40; attempt++) {
    last = await body(name)
    if (predicate(last)) return last
    await delay(250)
  }
  throw new Error(`The browser did not converge: ${last.path}: ${last.text.slice(0, 1000)}`)
}
await runWithScenarioResourceOwner('L1 two-device browser check', async owner => {
  let legacy, legacyHints = 0, stage = 'setup', result
  try {
    if (legacyOrigin && await sql("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leagues' AND column_name='future_pick_years')") === 'f') {
      await sql('ALTER TABLE public.leagues ADD COLUMN future_pick_years smallint NOT NULL DEFAULT 3 CONSTRAINT leagues_future_pick_years_check CHECK(future_pick_years BETWEEN 1 AND 10)')
      owner.register('Release 2.9.1 prerequisite column', () => sql('ALTER TABLE public.leagues DROP COLUMN future_pick_years'))
    }
    for (const [index, member] of fixture.members.entries()) {
      const headers = { apikey: keys.SERVICE_ROLE_KEY, Authorization: `Bearer ${keys.SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }
      const updated = await setupRequest(`${keys.API_URL}/auth/v1/admin/users/${member.user_id}`, {
        method: 'PUT', headers, body: JSON.stringify({ password }), signal: AbortSignal.timeout(20000), redirect: 'error',
      }, { operation: 'password', retries: setupRetries })
      assert.ok(updated.ok)
      const login = await setupRequest(`${keys.API_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST', headers: { apikey: keys.ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: member.email, password }), signal: AbortSignal.timeout(20000), redirect: 'error',
      }, { operation: 'login', retries: setupRetries })
      assert.ok(login.ok)
      const token = await login.json()
      const name = `${run}-device-${index}`
      const site = index === 0 && legacyOrigin ? legacyOrigin : origin
      sessions.push({ name, member, token, site })
      stage = `browser-open-${index}`
      await browser(name, ['--executable-path', chromium.executablePath(), '--args', `--host-resolver-rules=MAP ${new URL(origin).hostname} 127.0.0.1,--no-proxy-server`, '--ignore-https-errors', '--allowed-domains', new URL(origin).hostname, 'open', site], { timeout: 30000 })
      if (site === legacyOrigin) {
        const proof = await evaluate(name, '(async () => JSON.stringify(await (await fetch("/l1-release.json")).json()))()')
        assert.equal(proof.commit, released[legacyVersion])
        assert.equal(proof.version, legacyVersion)
      }
      await browser(name, ['set', 'viewport', '390', '844'])
      stage = `seed-session-${index}`
      await evaluate(name, `localStorage.setItem(${JSON.stringify(`sb-${new URL(origin).hostname.split('.')[0]}-auth-token`)},${JSON.stringify(JSON.stringify(token))}); JSON.stringify({ok:true})`)
      await browser(name, ['open', site])
      stage = `home-ready-${index}`
      await waitFor(name, state => state.text.includes(member.team_name) && state.path === '/')
      await evaluate(name, `(() => {
        window.__l1Joins=[];
        const send=WebSocket.prototype.send;
        WebSocket.prototype.send=function(data) {
          try { const frame=JSON.parse(data); if((Array.isArray(frame)?frame[3]:frame.event)==='phx_join') window.__l1Joins.push(Array.isArray(frame)?frame[2]:frame.topic); } catch {}
          return send.call(this,data);
        };
        return JSON.stringify({ok:true});
      })()`)
    }
    stage = 'legacy-join'
    legacy = createClient(keys.API_URL, keys.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    await legacy.realtime.setAuth(sessions[0].token.access_token)
    let ready = false
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Legacy join times out')), 20000)
      legacy.channel(`${run}-legacy`, { config: { private: true } })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'league_change_hints', filter: `league_id=eq.${fixture.members[0].league_id}` }, () => { legacyHints++ })
        .on('system', {}, event => { if (event.extension === 'postgres_changes' && event.status === 'ok') ready = true })
        .subscribe(status => { if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve() } })
    })
    for (let attempt = 0; attempt < 100 && !ready; attempt++) await delay(100)
    assert.ok(ready)
    stage = 'score-delivery'
    const updated = Number(await sql(`UPDATE public.matchups SET home_points=home_points+7.3 WHERE id='${fixture.matchup.id}' RETURNING home_points`, { measured: true }))
    for (const { name } of sessions) await waitFor(name, state => state.text.includes(updated.toFixed(1)))
    for (let attempt = 0; attempt < 50 && !legacyHints; attempt++) await delay(100)
    assert.ok(legacyHints > 0, 'The legacy client must still receive hints')
    const navigation = []
    for (const { name, site } of sessions) {
      for (const [label, expected] of [['Trades', '/trades'], ['Roster', '/roster'], ['Players', '/players'], ['Matchup', '/']]) {
        stage = `navigation-${label}`
        const clicked = await evaluate(name, `(() => {
          const label=${JSON.stringify(label)};
          const target=[...document.querySelectorAll('[role="tab"],[role="link"],button,[role="button"],a')].find(element => {
            const name=element.getAttribute('aria-label')??element.textContent.trim();
            return name===label || name.startsWith(label+',') || name.endsWith(label);
          });
          target?.click(); return JSON.stringify({clicked:!!target});
        })()`)
        assert.ok(clicked.clicked, `The ${label} tab must exist`)
        const state = await waitFor(name, state => state.path === expected)
        assert.ok(Array.isArray(state.joins), 'Navigation must keep the same document')
        navigation.push({ device: name, screen: label, joins: state.joins.length })
      }
      if (site !== legacyOrigin) assert.equal((await body(name)).joins.length, 0, 'Screen changes must reuse the league channel')
      await browser(name, ['screenshot', path.join(root, 'evidence', `${name}.png`)])
    }
    result = { status: 'pass', devices: 2, scoreVisibleOnBoth: true, legacyHints, navigation,
      legacyFrontendCommit: legacyOrigin ? released[legacyVersion] : null,
      legacyFrontendVersion: legacyOrigin ? legacyVersion : null }
  } catch (error) {
    const detail = String(error.stderr || error.message || error.name).split('\n')
      .filter(line => !/eval |access_token|refresh_token|Authorization|apikey/.test(line))
      .join('\n').replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]').slice(-1500)
    result = { status: 'fail', stage, error: error.name, detail }
    process.exitCode = 1
  } finally {
    await legacy?.removeAllChannels()
    for (const { name } of sessions) {
      await browser(name, ['close']).catch(() => {})
    }
    await sql(`UPDATE public.matchups SET home_points=${Number(fixture.matchup.home_points)} WHERE id='${fixture.matchup.id}'`)
    const file = legacyOrigin ? `agent-browser-release-${legacyVersion}.json` : 'agent-browser.json'
    await writeFile(path.join(root, 'evidence', file), JSON.stringify({ ...result, setupRetries }, null, 2), { mode: 0o600 })
  }
  console.log(JSON.stringify(result))
})
