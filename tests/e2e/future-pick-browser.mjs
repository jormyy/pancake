import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

assert.match(process.cwd(), /\/lanes\/fable-ui19\/repo$/)
assert.match(readFileSync('supabase/config.toml', 'utf8'), /^project_id = "pt4bafablepk"$/m)
const state = JSON.parse(readFileSync('../browser-state.json', 'utf8'))
const output = path.resolve('../evidence')
mkdirSync(output, { recursive: true })
const executable = path.resolve('node_modules/.bin/agent-browser')
const session = `future-picks-${crypto.randomUUID()}`
const origin = 'http://127.0.0.1:62580'
const call = (...args) => {
    const raw = execFileSync(executable, ['--session', session, '--allowed-domains', '127.0.0.1,localhost', '--json', ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000,
    })
    const result = JSON.parse(raw)
    assert.equal(result.success, true, `${args[0]} failed: ${result.error ?? ''}`)
    return result.data
}
const snapshot = () => call('snapshot').snapshot
const ref = (tree, role, name) => {
    const line = tree.split('\n').find(line => line.includes(`${role} "${name}"`))
    const match = line?.match(/\bref=(\w+)/)?.[1]
    assert.ok(match, `${role} ${name} missing`)
    return `@${match}`
}
const evaluate = expression => call('eval', expression).result
try {
    call('open', origin)
    call('set', 'viewport', '390', '1100')
    call('wait', '--text', 'Sign in')
    call('fill', ref(snapshot(), 'textbox', 'Email'), state.email)
    call('fill', ref(snapshot(), 'textbox', 'Password'), state.password)
    call('click', ref(snapshot(), 'button', 'Sign In'))
    call('wait', '--text', 'OFFICIAL LEAGUE')
    call('open', `${origin}/league?tab=picks`)
    call('wait', '--text', '2032 R3')
    const leagueTree = snapshot()
    writeFileSync(`${output}/league-picks-390.txt`, leagueTree)
    assert.ok(leagueTree.includes('OFFICIAL LEAGUE'))
    for (const year of [2028, 2029, 2030, 2031, 2032]) assert.ok(leagueTree.includes(`${year} R3`), `league ${year}`)
    assert.equal(evaluate('innerWidth'), 390)
    assert.equal(evaluate('document.documentElement.scrollWidth > innerWidth'), false)
    call('screenshot', `${output}/league-picks-390.png`)
    process.stdout.write('League screenshot captured. Opening trade builder.\n')
    call('open', `${origin}/propose-trade?recipientMemberId=${state.recipientMemberId}`)
    process.stdout.write('Trade builder opened. Waiting for picks.\n')
    call('wait', '--text', '2032 Round 3')
    call('set', 'viewport', '390', '1440')
    evaluate(`(() => {
        const pick = [...document.querySelectorAll('[role="button"]')].find(node => node.getAttribute('aria-label')?.startsWith('Select 2028 Round 1 pick'));
        if (!pick) throw new Error('first pick unavailable');
        pick.scrollIntoView({block:'start'});
        return true;
    })()`)
    const builderTree = snapshot()
    writeFileSync(`${output}/trade-picks-390.txt`, builderTree)
    for (const year of [2028, 2029, 2030, 2031, 2032]) assert.ok(builderTree.includes(`${year} Round 3`), `builder ${year}`)
    assert.equal(evaluate('innerWidth'), 390)
    assert.equal(evaluate('document.documentElement.scrollWidth > innerWidth'), false)
    call('screenshot', `${output}/trade-picks-390.png`)
    const fifth = builderTree.split('\n').find(line => line.includes('button "Select 2032 Round 3 pick'))?.match(/\bref=(\w+)/)?.[1]
    assert.ok(fifth)
    call('click', `@${fifth}`)
    assert.ok(snapshot().includes('Remove 2032 Round 3 pick'))
    writeFileSync(`${output}/browser-result.json`, JSON.stringify({ leagueYears: [2028, 2029, 2030, 2031, 2032], builderYears: [2028, 2029, 2030, 2031, 2032], width: 390, fifthYearSelected: true }, null, 2))
    process.stdout.write('PASS: OFFICIAL LEAGUE and trade picker show 2028–2032 at 390 px; fifth-year pick selects.\n')
} catch (error) {
    writeFileSync(`${output}/browser-failure.txt`, snapshot())
    call('screenshot', `${output}/browser-failure.png`)
    throw error
} finally {
    call('close')
}
