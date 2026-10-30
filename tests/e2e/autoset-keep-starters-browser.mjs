import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

assert.match(await readFile('supabase/config.toml', 'utf8'), /^project_id = "pt4bafableas"$/m)
const stack = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
assert.equal(stack.API_URL, 'http://127.0.0.1:64021')
const { origin } = JSON.parse(await readFile('../browser-origin.json', 'utf8'))
assert.equal(new URL(origin).port, '64084')
const fixture = JSON.parse(await readFile('tests/fixtures/autoset-michael.json', 'utf8'))
const replay = JSON.parse(await readFile('../autoset-after.json', 'utf8'))
const output = path.resolve('../autoset-browser')
await mkdir(output, { recursive: true })
const checked = async operation => { const { data, error } = await operation; assert.ifError(error); return data }
const admin = createClient(stack.API_URL, stack.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const member = await checked(admin.from('league_members').select('id,user_id,league_id').eq('id', fixture.member.id).single())
const email = `autoset-${randomUUID()}@example.invalid`, password = randomUUID()
const { user } = await checked(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: 'Michael fixture' } }))
const sessionName = `fable-ui26-${randomUUID()}`
const call = (...args) => {
    const raw = execFileSync(path.resolve('node_modules/.bin/agent-browser'), ['--session', sessionName, '--ignore-https-errors', '--args', `--host-resolver-rules=MAP ${new URL(origin).hostname} 127.0.0.1`, '--json', ...args], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = JSON.parse(raw)
    assert.equal(result.success, true, `agent-browser ${args[0]}`)
    return result.data
}
const sql = statement => execFileSync('docker', ['exec', '-i', 'supabase_db_pt4bafableas', 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const slate = sql(`SELECT jsonb_agg(to_jsonb(g)) FROM nba_games g WHERE game_date IN ('2026-10-29','2026-10-30');`)
const requests = [], views = [], blocked = []
let browser
try {
    sql(`UPDATE nba_games SET game_time=now()+interval '2 days',started_at=NULL,status='Scheduled' WHERE game_date IN ('2026-10-29','2026-10-30');`)
    await checked(admin.from('league_members').update({ user_id: user.id }).eq('id', member.id))
    for (const day of replay) {
        assert.equal(day.filled, 10)
        sql(`BEGIN; SELECT set_config('request.jwt.claim.sub','${user.id}',true);
          SELECT public.auto_set_lineup_atomic_unchecked('${member.id}','${member.league_id}','${fixture.member.season_id}','${day.date}','${JSON.stringify(day.assignments).replaceAll("'", "''")}'::jsonb); COMMIT;`)
    }
    const auth = createClient(stack.API_URL, stack.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const { session } = await checked(auth.auth.signInWithPassword({ email, password }))
    call('open', 'about:blank')
    const endpoint = call('get', 'cdp-url')
    browser = await chromium.connectOverCDP(typeof endpoint === 'string' ? endpoint : endpoint.url ?? endpoint.cdpUrl)
    const context = browser.contexts()[0]
    const page = context.pages()[0]
    await page.setViewportSize({ width: 390, height: 1600 })
    await context.route('**/*', route => {
        const url = new URL(route.request().url())
        if (url.origin === origin || ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port.startsWith('640') || ['data:', 'blob:'].includes(url.protocol)) return route.continue()
        blocked.push({ hostname: url.hostname, path: url.pathname })
        return route.abort()
    })
    await context.addInitScript(({ session, member }) => {
        localStorage.setItem(`sb-${location.hostname.split('.')[0]}-auth-token`, JSON.stringify(session))
        localStorage.setItem(`pancake:selected-league:v1:${session.user.id}`, JSON.stringify({ version: 1, savedAt: Date.now(), value: member.id }))
    }, { session, member })
    page.on('response', async response => {
        const url = new URL(response.url())
        if (!url.pathname.includes('/views/home')) return
        requests.push({ path: url.pathname, status: response.status(), params: url.searchParams.get('params') })
        const body = await response.json().catch(() => null)
        if (body?.view) views.push(body.view)
    })
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    for (const [date, label] of [['2026-10-29', 'Thursday, October 29'], ['2026-10-30', 'Friday, October 30']]) {
        await page.getByRole('button', { name: label, exact: true }).first().click({ timeout: 45000 })
        await page.waitForFunction(label => document.querySelector(`[aria-label="${label}"][aria-current="date"]`), label)
        await page.waitForTimeout(1500)
        const view = views.findLast(view => view.selectedDate === date && view.myLineup?.starters)
        assert.ok(view, `Home view for ${date}`)
        assert.equal(view.myLineup.starters.length, 10)
        assert.equal(view.myLineup.starters.filter(slot => slot.player).length, 10)
        assert.equal(view.matchup.myTeamName, "Mike's Minions")
        assert.equal(await page.evaluate(() => innerWidth), 390)
        call('screenshot', path.join(output, `${date}-after-390.png`))
        await writeFile(path.join(output, `${date}-visible.txt`), await page.locator('body').innerText())
    }
    await writeFile(path.join(output, 'verification.json'), `${JSON.stringify({ width: 390, height: 1600, team: fixture.member.team_name,
        dates: replay.map(day => ({ date: day.date, filled: day.filled })), requests, blockedExternalRequests: blocked.length,
        simulation: 'Games were delayed only in the private database to replay the stored dates before tipoff.',
        productionContacted: false, agentBrowserSession: sessionName }, null, 2)}\n`)
    console.log('PASS: Thursday and Friday show 10/10 starters at 390 px after auto-set.')
} finally {
    if (browser) await browser.close()
    try { call('close') } catch {}
    await checked(admin.from('league_members').update({ user_id: member.user_id }).eq('id', member.id))
    sql(`UPDATE nba_games g SET game_time=r.game_time,started_at=r.started_at,status=r.status
      FROM jsonb_populate_recordset(NULL::nba_games,'${slate.replaceAll("'", "''")}'::jsonb) r WHERE g.id=r.id;`)
    await checked(admin.auth.admin.deleteUser(user.id))
}
