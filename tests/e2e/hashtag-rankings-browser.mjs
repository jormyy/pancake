import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export async function verifyHashtagBrowser() {
  assert.match(readFileSync('supabase/config.toml', 'utf8'), /^project_id = "pt4bafableht"$/m)
  const state = JSON.parse(readFileSync('../hashtag-browser-state.json', 'utf8'))
  const origin = 'http://127.0.0.1:59080'
  const executable = path.resolve('node_modules/.bin/agent-browser')
  const session = `hashtag-${crypto.randomUUID()}`
  const call = (...args) => {
    let raw
    try {
      raw = execFileSync(executable, ['--session', session, '--allowed-domains', '127.0.0.1,localhost', '--json', ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000,
      })
    } catch {
      throw new Error(`Browser step failed: ${args[0]}`)
    }
    const result = JSON.parse(raw)
    assert.equal(result.success, true, `Browser step failed: ${args[0]}`)
    return result.data
  }
  const snapshot = () => call('snapshot').snapshot
  const ref = (tree, role, name) => {
    const line = tree.split('\n').find(line => line.includes(`${role} "${name}"`))
    const target = line?.match(/\bref=(\w+)/)?.[1]
    assert.ok(target, `${role} ${name} is missing`)
    return `@${target}`
  }
  const evaluate = expression => call('eval', expression).result
  const evidence = { player: [], pick: null }
  execFileSync(executable, ['session', 'list'], { stdio: 'ignore', timeout: 10000 })
  try {
    call('open', origin)
    call('wait', '--text', 'Sign in')
    call('fill', ref(snapshot(), 'textbox', 'Email'), state.email)
    call('fill', ref(snapshot(), 'textbox', 'Password'), state.password)
    call('click', ref(snapshot(), 'button', 'Sign In'))
    call('wait', '--text', 'Hashtag regression')
    call('open', `${origin}/player/${state.playerId}`)
    call('wait', '--text', '5-year points 10')
    for (const [width, height, name] of [[1280, 900, 'desktop'], [393, 852, 'phone']]) {
      call('set', 'viewport', String(width), String(height))
      const tree = snapshot()
      for (const label of ['Dynasty #21', '5-year points 10', '3-year points 12']) assert.ok(tree.includes(label), label)
      assert.ok(!tree.includes('Value 900.9'))
      const layout = evaluate(`(() => {
        const summary = document.querySelector('[data-testid="player-summary-line"]');
        const bounds = summary.getBoundingClientRect();
        return { width: innerWidth, left: bounds.left, right: bounds.right, bottom: bounds.bottom,
          height: innerHeight, text: summary.textContent, viewRequests: performance.getEntriesByType('resource')
            .filter(entry => new URL(entry.name).pathname === '/functions/v1/api/views/player').length };
      })()`)
      assert.ok(layout.viewRequests > 0)
      assert.ok(layout.left >= 0 && layout.right <= layout.width + 1 && layout.bottom <= layout.height)
      evidence.player.push({ name, ...layout })
      call('screenshot', path.resolve(`../hashtag-player-${name}.png`))
    }
    call('open', `${origin}/players?section=rankings`)
    call('wait', '--text', 'Rookies & Picks')
    call('click', ref(snapshot(), 'tab', '3-Year Points'))
    call('wait', '--text', 'Cooper Flagg')
    assert.match(snapshot(), /3-Year Points.*selected/)
    call('click', ref(snapshot(), 'tab', 'Rookies & Picks'))
    call('fill', ref(snapshot(), 'textbox', 'Search dynasty rankings'), `${state.seasonYear} Round 1`)
    call('wait', '--text', `${state.seasonYear} Round 1`)
    const picks = snapshot()
    assert.ok(picks.includes('Value 441–796'))
    assert.ok(!picks.includes('Value 0'))
    evidence.pick = { year: state.seasonYear, range: [441, 796], tradeBandsForYear: 0 }
    call('screenshot', path.resolve('../hashtag-current-year-pick.png'))
    writeFileSync('../hashtag-browser-evidence.json', JSON.stringify(evidence, null, 2) + '\n')
    console.log('PASS: player view renders both Hashtag forecasts on desktop and phone; current-year rookie pick shows 441–796 without trade bands')
  } finally {
    call('close')
    let closed = false
    for (let attempt = 0; attempt < 10; attempt++) {
      const sessions = execFileSync(executable, ['session', 'list'], { encoding: 'utf8', timeout: 10000 })
      if (!sessions.includes(session)) {
        closed = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(closed, 'Automation browser did not close')
  }
}
