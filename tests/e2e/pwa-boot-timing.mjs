import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, webkit, devices } from 'playwright'

const directory = `${process.env.TASK_DIR}/evidence/stage2/lane-b/returning-shell`
await mkdir(directory, { recursive: true })
let variant = 'before'
const server = createServer((request, response) => {
  const upstream = httpRequest({ hostname: '127.0.0.1', port: variant === 'before' ? 56850 : 56851, path: request.url, headers: request.headers }, incoming => {
    const parts = []
    incoming.on('data', part => parts.push(part))
    incoming.on('end', () => {
      const send = () => { response.writeHead(incoming.statusCode, incoming.headers); response.end(Buffer.concat(parts)) }
      if (/\.js$/.test(request.url)) setTimeout(send, 3000)
      else send()
    })
  })
  upstream.on('error', () => { response.writeHead(502); response.end() })
  upstream.end()
})
await new Promise(resolve => server.listen(56856, '127.0.0.1', () => resolve(undefined)))
const samples = []
try {
  for (const engine of ['chromium', 'webkit']) for (const build of ['before', 'after']) for (let sample = 1; sample <= 3; sample++) {
    variant = build
    const context = await (engine === 'chromium' ? chromium : webkit).launchPersistentContext(`${directory}/${engine}-${build}-${sample}-${Date.now()}`, {
      headless: true, ...(engine === 'webkit' ? devices['iPhone 13'] : { viewport: { width: 1280, height: 900 } }),
    })
    try {
      await context.addInitScript(() => {
        const userId = 'synthetic-returning-owner'
        const expires = Math.floor(Date.now() / 1000) + 3600
        const encode = value => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
        const token = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: 'http://127.0.0.1:56859/auth/v1', sub: userId, aud: 'authenticated', role: 'authenticated', exp: expires, iat: expires - 3600 })}.Zml4dHVyZQ`
        localStorage.setItem('sb-127-auth-token', JSON.stringify({ user: { id: userId, aud: 'authenticated' }, token_type: 'bearer', refresh_token: 'synthetic-only', expires_at: expires, access_token: token }))
        const envelope = value => JSON.stringify({ version: 1, savedAt: Date.now(), value })
        localStorage.setItem(`pancake:league-memberships:v1:${userId}`, envelope([{ id: 'local-league', team_name: 'Local Team', role: 'member', leagues: { name: 'Local League' } }]))
        localStorage.setItem(`pancake:selected-league:v1:${userId}`, envelope('local-league'))
        const original = window.fetch.bind(window)
        window.fetch = (input, init) => {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
          if (/\/(auth|rest|functions)\/v1\//.test(url.pathname)) throw new Error('Synthetic shell cannot call data APIs')
          return original(input, init)
        }
      })
      const page = await context.newPage()
      await page.goto('http://127.0.0.1:56856/roster', { waitUntil: 'commit' })
      await page.waitForFunction(() => Reflect.get(window, '__PANCAKE_BOOT__'), undefined, { timeout: 2000 })
      await page.waitForTimeout(80)
      const measurement = await page.evaluate(() => ({ shellMs: performance.getEntriesByName('pancake-boot-shell')[0]?.startTime ?? null,
        fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
        mountedMs: performance.getEntriesByName('pancake-app-mounted')[0]?.startTime ?? null,
        identity: Reflect.get(window, '__PANCAKE_BOOT__') }))
      assert.equal(measurement.identity.team, 'Local Team')
      assert.equal(measurement.identity.active, '/roster')
      assert.notEqual(measurement.shellMs, null)
      assert.equal(measurement.mountedMs, null)
      samples.push({ engine, build, sample, ...measurement })
      if (sample === 1) await page.screenshot({ path: `${directory}/${engine}-${build}.png` })
    } finally { await context.close() }
  }
} finally { await new Promise(resolve => server.close(resolve)) }
await writeFile(`${directory}/results.json`, JSON.stringify({ method: 'Synthetic local returning identity. Actual exported HTML. Application scripts wait three seconds so the cosmetic shell can be observed alone. This measures shell paint, not authentication or app readiness. New-visitor readiness is reported by the unmodified first-load measurement loop.', samples }, null, 2))
console.log(JSON.stringify(samples))
