import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'

const requireLocal = value => assert.ok(['127.0.0.1', 'localhost'].includes(new URL(value).hostname), `Refusing non-local target ${value}`)
const BUDGET_MS = 10_000
const OFFLINE_MS = 2_000

const dir = path.resolve(process.argv[2])
const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
const env = JSON.parse(await readFile(path.join(dir, 'local-env.json'), 'utf8'))
const fixture = JSON.parse(await readFile(path.join(dir, 'fixture.json'), 'utf8'))
const state = JSON.parse(await readFile(path.join(run.work, 'tests/e2e-state.json'), 'utf8'))
assert.ok(!run.cleanedAt)
requireLocal(run.url)
requireLocal(env.E2E_SUPABASE_URL)
const admin = createClient(env.E2E_SUPABASE_URL, env.E2E_PANCAKE_SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const evidence = path.join(path.dirname(dir), 'reconnect-recovery')
await mkdir(evidence, { recursive: true })

const { data: members, error } = await admin.from('league_members').select('id,team_name').eq('league_id', fixture.leagueId).eq('team_name', 'E2E Team 1')
if (error) throw error
assert.equal(members.length, 1, 'fixture team E2E Team 1')
const member = members[0]
const rename = async name => {
    const { error: write } = await admin.from('league_members').update({ team_name: name }).eq('id', member.id)
    if (write) throw write
}
const { data: active, error: rosterError } = await admin.from('roster_players').select('*').eq('member_id', member.id).eq('is_on_ir', false).eq('is_on_taxi', false)
if (rosterError) throw rosterError
assert.ok(active.length > 1, 'fixture active roster')
let released = null
const screens = [
    { tab: 'League', before: member.team_name, mutate: () => rename('Recovered Team'), after: 'Recovered Team' },
    {
        tab: 'Roster', before: `${active.length}/`, after: `${active.length - 1}/`,
        mutate: async () => {
            for (const row of active) {
                const { error: write } = await admin.from('roster_players').delete().eq('id', row.id)
                if (!write) { released = row; return }
            }
            throw new Error('Every fixture roster player is locked')
        },
    },
]

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', failure => pageErrors.push(failure.message))
const results = []
try {
    await page.goto(run.url + '/sign-in')
    await page.waitForTimeout(1_500)
    await page.getByPlaceholder('you@example.com').fill(state.users[0].email)
    await page.getByPlaceholder('Your password').fill(state.password)
    await page.getByRole('button', { name: 'Sign In', exact: true }).click()
    await page.getByRole('link', { name: 'Roster', exact: true }).waitFor()
    for (const screen of screens) {
        await page.getByRole('link', { name: screen.tab, exact: true }).click()
        await page.waitForFunction(text => document.body.innerText.includes(text), screen.before)
        await page.waitForTimeout(1_500)
        await context.setOffline(true)
        await screen.mutate()
        await page.waitForTimeout(OFFLINE_MS)
        const staleWhileOffline = await page.evaluate(text => !document.body.innerText.includes(text), screen.after)
        await context.setOffline(false)
        const started = Date.now()
        const fresh = await page.waitForFunction(text => document.body.innerText.includes(text), screen.after, { timeout: BUDGET_MS }).then(() => true, () => false)
        const elapsedMs = Date.now() - started
        await page.screenshot({ path: path.join(evidence, `${screen.tab.toLowerCase()}-after-reconnect.png`) })
        results.push({ screen: screen.tab, staleWhileOffline, fresh, elapsedMs })
        assert.ok(fresh, `${screen.tab} kept pre-reconnect data for ${BUDGET_MS}ms. Read it through useFocusAsyncData or useScreenView, or subscribe with onLifecycle from lib/lifecycle.`)
    }
    assert.deepEqual(pageErrors, [])
    console.log(JSON.stringify({ passed: true, budgetMs: BUDGET_MS, results }))
} catch (failure) {
    await page.screenshot({ path: path.join(evidence, 'failed.png') }).catch(() => {})
    throw failure
} finally {
    await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ results, pageErrors }, null, 2))
    await rename(member.team_name).catch(() => {})
    if (released) await admin.from('roster_players').insert(released)
    await browser.close()
}
