import { webkit } from 'playwright'
import path from 'node:path'
import { withDatabase } from '../../scripts/perf-lab/setup.mjs'
import { localKeys } from '../../scripts/perf-lab/database.mjs'
import { certificate, buildWeb } from '../../scripts/perf-lab/build.mjs'
import { captureServer } from '../../scripts/perf-lab/capture.mjs'
import { json } from '../../scripts/perf-lab/common.mjs'

await withDatabase(async ({ evidence }) => {
  const keys = await localKeys()
  const email = `probe-${crypto.randomUUID()}@example.test`, password = crypto.randomUUID()
  const headers = { apikey: keys.SERVICE_ROLE_KEY, Authorization: `Bearer ${keys.SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }
  await fetch(`${keys.API_URL}/auth/v1/admin/users`, { method: 'POST', headers, body: JSON.stringify({ email, password, email_confirm: true }) })
  const tls = await certificate()
  const build = await buildWeb(keys, tls)
  process.env.PERF_LAB_ALLOW_LAN = '1'
  const server = await captureServer({ root: build.root, evidence, ...tls, host: '0.0.0.0' })
  const browser = await webkit.launch()
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${tls.origin}/sign-in`)
    await page.locator('#root').getByPlaceholder('you@example.com').fill(email)
    await page.locator('#root').getByPlaceholder('Your password').fill(password)
    await page.locator('#root').getByRole('button', { name: 'Sign In', exact: true }).click()
    await page.waitForTimeout(3000)
    const result = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(name => name.endsWith('-auth-token'))
      const value = key ? JSON.parse(localStorage.getItem(key)) : null
      const claims = value?.access_token ? JSON.parse(atob(value.access_token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))) : null
      const header = value?.access_token ? JSON.parse(atob(value.access_token.split('.')[0].replaceAll('-', '+').replaceAll('_', '/'))) : null
      return { key, claims, header, expiresAt: value?.expires_at, userAudience: value?.user?.aud, now: Date.now(), text: document.body.innerText }
    })
    await page.screenshot({ path: path.join(evidence, 'auth-probe.png') })
    await json(path.join(evidence, 'auth-probe.json'), { ...result, errors })
    console.log(JSON.stringify({ ...result, claims: result.claims && { iss: result.claims.iss, iat: result.claims.iat, exp: result.claims.exp, role: result.claims.role, aud: result.claims.aud }, errors }))
  } finally { await browser.close(); await server.close() }
}, { restore: false })
