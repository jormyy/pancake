import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv } from './env.mjs'

import { pathToFileURL } from 'node:url'

export function summarizeProfileRequests(requests) {
  const views = requests.filter(request => request.path === '/functions/v1/api/views/player')
  return { requests, count: requests.length, bytes: requests.reduce((sum, request) => sum + request.bytes, 0), viewCount: views.length, viewBytes: views.reduce((sum, request) => sum + request.bytes, 0) }
}

async function capturePlayerProfile() {
  const env = resolvedEnv()
  assert.equal(env.supabaseUrl, 'http://127.0.0.1:57721')
  assert.equal(env.frontendUrl, 'http://127.0.0.1:57780')
  const state = JSON.parse(await readFile('tests/e2e-state.json', 'utf8'))
  const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  const login = await client.auth.signInWithPassword({ email: state.users[0].email, password: state.password })
  if (login.error) throw login.error
  const { data: player, error } = await client.from('players').select('id').eq('sportsdata_id', 'e2e-player-001').single()
  if (error) throw error
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: process.argv[3] === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 900 } })
  let warmProfile = false
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (warmProfile && url.pathname === '/functions/v1/api/views/player') await new Promise(resolve => setTimeout(resolve, 800))
    return ['127.0.0.1', 'localhost'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('requestfailed', request => { const url = new URL(request.url()); console.log('Failed request', url.origin + url.pathname, request.failure()?.errorText) })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let requests = []
  const captures = []
  page.on('response', response => {
    if (!response.url().startsWith(env.supabaseUrl)) return
    captures.push((async () => {
      const request = response.request()
      if (request.method() === 'OPTIONS') return
      const body = await response.body().catch(() => Buffer.alloc(0))
      const url = new URL(response.url())
      requests.push({ path: url.pathname, section: JSON.parse(url.searchParams.get('params') ?? '{}').section ?? null, status: response.status(), bytes: body.length })
    })())
  })
  await page.goto(env.frontendUrl + '/players')
  console.log('Opened sign-in screen')
  await page.getByRole('textbox', { name: 'Email' }).fill(state.users[0].email)
  await page.locator('input[type=password]').fill(state.password)
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  console.log('Submitted local fixture sign-in')
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('sb-127-auth-token') ?? 'null')?.access_token)
  await page.goto(env.frontendUrl + '/players')
  await page.getByPlaceholder('Search players...').waitFor({ timeout: 30000 }).catch(async error => { console.log(await page.locator('body').innerText()); console.log(errors); throw error })
  await page.waitForTimeout(1500)
  if (process.argv[2] === 'after') {
    await page.getByRole('button', { name: /^Sort:/ }).click()
    await page.getByRole('button', { name: 'Dynasty rank', exact: true }).click()
    await page.getByRole('button', { name: 'Sort: Dynasty rank', exact: true }).waitFor()
    await page.reload()
    await page.getByRole('button', { name: 'Sort: Dynasty rank', exact: true }).waitFor()
  }
  await Promise.all(captures)
  requests = []
  await page.goto(`${env.frontendUrl}/player/${player.id}`)
  await page.getByText('E2E Player001', { exact: true }).first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(1500)
  await Promise.all(captures)
  const cold = requests.slice()
  const firstText = await page.locator('body').innerText()
  await page.screenshot({ path: `../${process.argv[2] ?? 'profile'}-cold.png`, fullPage: true })
  await page.goto(env.frontendUrl + '/players')
  await page.getByPlaceholder('Search players...').waitFor()
  await page.waitForTimeout(1000)
  await Promise.all(captures)
  requests = []
  warmProfile = true
  await page.goto(`${env.frontendUrl}/player/${player.id}`)
  await page.getByText('E2E Player001', { exact: true }).first().waitFor()
  const warmPaintBeforeResponse = !requests.some(request => request.path === '/functions/v1/api/views/player')
  await page.waitForTimeout(2000)
  await Promise.all(captures)
  const warm = requests.slice()
  const lazy = []
  if (process.argv[2] === 'after') {
    warmProfile = false
    for (const label of ['Game log', 'News', 'League history']) {
      requests = []
      await page.getByRole('button', { name: label, exact: true }).click()
      await page.waitForTimeout(1000)
      await Promise.all(captures)
      lazy.push({ section: label, ...summarizeProfileRequests(requests) })
      console.log(JSON.stringify(lazy.at(-1)))
      const section = { 'Game log': 'games', News: 'news', 'League history': 'history' }[label]
      assert.equal(lazy.at(-1).requests.filter(request => request.section === section).length, 1)
    }
    await page.getByText('Profile fixture update', { exact: true }).first().waitFor()
    await page.screenshot({ path: '../after-expanded.png', fullPage: true })
  }
  const report = { cold: summarizeProfileRequests(cold), warm: summarizeProfileRequests(warm), warmPaintBeforeResponse, lazy, errors, content: firstText }
  await writeFile(`../${process.argv[2] ?? 'profile'}.json`, JSON.stringify(report, null, 2))
  assert.equal(errors.length, 0)
  assert.equal(report.cold.viewCount, 1)
  assert.equal(report.warm.viewCount, 1)
  assert.equal(warmPaintBeforeResponse, true)
  console.log(JSON.stringify({ warmPaintBeforeResponse, lazy, cold: { count: report.cold.count, bytes: report.cold.bytes, requests: cold }, warm: { count: report.warm.count, bytes: report.warm.bytes, requests: warm }, errors }))
  await context.close()
  await browser.close()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await capturePlayerProfile()
