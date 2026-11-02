import { evidencePath } from '../helpers/evidence-path.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

assert.match(process.cwd(), /\/lanes\/fable-ui25\/repo$/)
assert.match(readFileSync('supabase/config.toml', 'utf8'), /^project_id = "pt4bafabletc"$/m)
const state = JSON.parse(readFileSync('../browser-state.json', 'utf8'))
const output = evidencePath('trade-curve')
mkdirSync(output, { recursive: true })
const executable = path.resolve('node_modules/.bin/agent-browser')
const session = `trade-curve-${crypto.randomUUID()}`
const origin = 'http://127.0.0.1:63980'
const call = (...args) => {
  const raw = execFileSync(executable, ['--session', session, '--allowed-domains', '127.0.0.1,localhost', '--json', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000,
  })
  if (!['snapshot', 'eval'].includes(args[0])) process.stdout.write(`${args[0]} completed\n`)
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
const capture = name => {
  assert.equal(evaluate('innerWidth'), 390)
  assert.equal(evaluate('document.documentElement.scrollWidth > innerWidth'), false)
  call('screenshot', path.join(output, `${name}-390.png`))
  writeFileSync(path.join(output, `${name}-390.txt`), snapshot())
}
try {
  call('open', origin)
  call('set', 'viewport', '390', '1100')
  call('wait', '--text', 'Sign in')
  call('fill', ref(snapshot(), 'textbox', 'Email'), state.email)
  call('fill', ref(snapshot(), 'textbox', 'Password'), state.password)
  call('click', ref(snapshot(), 'button', 'Sign In'))
  call('wait', '--text', 'OFFICIAL LEAGUE')
  call('open', `${origin}/trades?tab=${state.tab}`)
  call('wait', '--text', '% gap')
  const cards = snapshot()
  assert.ok(cards.includes('Net'))
  assert.ok(cards.includes('wins') || cards.includes('Fair'))
  evaluate(`(() => {
    const card = document.querySelector('[data-testid="trade-saved-estimate-${state.tradeId}"]');
    if (!card) throw new Error('real trade card is missing');
    card.scrollIntoView({block:'center'});
    return true;
  })()`)
  capture('trade-card')
  call('click', `#trade-analyze-${state.tradeId}`)
  call('wait', '--text', 'Curved package totals')
  const analysis = snapshot()
  assert.ok(analysis.includes('% gap'))
  assert.ok(analysis.includes('Source'))
  assert.ok(analysis.includes('Spots'))
  if (state.tab === 'offers') {
    assert.ok(analysis.includes('Cuts '))
    assert.ok(!analysis.includes('Spots '))
  }
  evaluate(`(() => {
    const summary = document.querySelector('[aria-label="Dynasty trade analysis"]');
    if (!summary) throw new Error('analysis summary is missing');
    summary.scrollIntoView({block:'start'});
    return true;
  })()`)
  capture('analyzer')
  const resources = evaluate('performance.getEntriesByType("resource").map(entry => entry.name).filter(name => name.includes("supabase.co"))')
  assert.deepEqual(resources, [])
  writeFileSync(path.join(output, 'browser.json'), JSON.stringify({ width: 390, tradeId: state.tradeId,
    card: true, analyzer: true, horizontalOverflow: false, productionRequests: resources.length }, null, 2) + '\n')
  process.stdout.write('PASS: real trade card and analyzer show curved totals, net values, gap and verdict at 390 px.\n')
} catch (error) {
  writeFileSync(path.join(output, 'browser-failure.txt'), snapshot())
  call('screenshot', path.join(output, 'browser-failure.png'))
  throw error
} finally {
  call('close')
}
