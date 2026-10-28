import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const exec = promisify(execFile)
const session = `p4-reader-check-${process.pid}`
const fixture = JSON.parse(await readFile('../reader-fixture.json', 'utf8'))
const directory = path.resolve('../reader-evidence')
await mkdir(directory, { recursive: true })
const browser = async (...args) => (await exec('./node_modules/.bin/agent-browser', ['--session', session, ...args], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 })).stdout
const body = () => browser('eval', 'document.body.innerText')
const waitFor = async predicate => {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const text = await body()
    if (predicate(text)) return text
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  throw new Error('Expected screen content did not appear')
}
const click = async label => {
  const snapshot = await browser('snapshot', '-i')
  const row = snapshot.split('\n').find(row => row.includes(`"${label}"`) && row.includes('ref='))
  assert.ok(row, `Control exists: ${label}`)
  await browser('click', `@${row.match(/ref=(e\d+)/)[1]}`)
}
const capture = name => browser('screenshot', path.join(directory, `${name}.png`))
const importValues = async content => {
  const response = await fetch('http://127.0.0.1:57821/functions/v1/sync-trade-values', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-function-token': 'pancake-local-edge-auth-probe-token' },
    body: JSON.stringify({ format: 'json', content }),
  })
  assert.equal(response.status, 200, await response.text())
}
const checks = []
try {
  await browser('open', 'http://127.0.0.1:57880/players')
  await waitFor(text => text.includes('Sign in'))
  let snapshot = await browser('snapshot', '-i')
  const email = snapshot.split('\n').find(row => row.includes('textbox "Email"')).match(/ref=(e\d+)/)[1]
  const password = snapshot.split('\n').find(row => row.includes('textbox "Password"')).match(/ref=(e\d+)/)[1]
  await browser('fill', `@${email}`, fixture.userEmail)
  await browser('fill', `@${password}`, 'Pancake-value-readers-2026!')
  await click('Sign In')
  await waitFor(text => text.includes('Matchup') && !text.includes('Sign in'))
  await click('Players')
  await waitFor(text => text.includes('Rankings'))
  await click('Rankings')
  await waitFor(text => text.includes(`Value ${fixture.expected.first}`) && text.includes(`Value ${fixture.expected.second}`))
  checks.push('Players shows source values')
  await capture('players')
  const source = await readFile('tests/fixtures/trade-values/onenumberhoops.json', 'utf8')
  const changed = JSON.parse(source)
  changed.data.find(player => player.id === 'victorwembanyama').value = 8888
  try {
    await importValues(JSON.stringify(changed))
    await waitFor(text => text.includes('Value 888.8'))
  } finally {
    await importValues(source)
  }
  await waitFor(text => text.includes(`Value ${fixture.expected.first}`))
  checks.push('Visible rankings refresh after source updates')
  await click('Rookies & Picks')
  snapshot = await browser('snapshot', '-i')
  const search = snapshot.split('\n').find(row => row.includes('textbox "Search dynasty rankings"')).match(/ref=(e\d+)/)[1]
  await browser('fill', `@${search}`, '2027 Round 1')
  await waitFor(text => text.includes('391.4') && text.includes('750.1'))
  checks.push('Pick ranges use the stored source bands')
  await capture('picks')
  snapshot = await browser('snapshot', '-i')
  const currentSearch = snapshot.split('\n').find(row => row.includes('textbox "Search dynasty rankings"')).match(/ref=(e\d+)/)[1]
  await browser('fill', `@${currentSearch}`, 'Victor')
  await click('5-Year Points')
  await waitFor(text => text.includes('Victor Wembanyama'))
  await click('Open Victor Wembanyama')
  await waitFor(text => text.includes(`Value ${fixture.expected.first}`) && text.includes('RECENT GAMES'))
  checks.push('Player profile shows source value')
  await capture('profile')
  await click('Trades')
  await waitFor(text => text.includes(`${fixture.expected.first} vs ${fixture.expected.second}`))
  checks.push('Trade cards show source values')
  await capture('cards')
  await click('Revalue trade from Value Team 1 with current inputs')
  await waitFor(text => text.includes(`Value ${fixture.expected.first}`) && text.includes(`Value ${fixture.expected.second}`))
  checks.push('Trade analyzer shows source values')
  await capture('analyzer')
  assert.equal((await browser('errors')).trim(), '')
  await writeFile(path.join(directory, 'result.json'), `${JSON.stringify({ passed: checks.length, checks, expected: fixture.expected }, null, 2)}\n`)
  console.log(JSON.stringify({ passed: checks.length, checks }))
} catch (error) {
  await writeFile(path.join(directory, 'failure.txt'), `${String(error)}\n${await body()}\n${await browser('errors')}\n${await browser('console')}`)
  await capture('failure')
  throw error
} finally {
  await browser('close')
  const deadline = Date.now() + 10000
  let sessions = ''
  do {
    sessions = (await exec('./node_modules/.bin/agent-browser', ['session', 'list'])).stdout
    if (!sessions.includes(session)) break
    await new Promise(resolve => setTimeout(resolve, 300))
  } while (Date.now() < deadline)
  assert.ok(!sessions.includes(session), 'Owned browser session is closed')
}
