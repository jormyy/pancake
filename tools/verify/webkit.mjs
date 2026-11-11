#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { webkit } from 'playwright'
import { fileURLToPath } from 'node:url'
import { requireLocal } from './run.mjs'

const [dirArg, action, ...args] = process.argv.slice(2)
const dir = path.resolve(dirArg)
const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
assert.equal(run.dir, dir)
assert.equal(run.repo, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))
assert.match(run.id, /^pancake-verify-[a-z0-9-]+$/)
assert.ok(run.readyAt, 'Wait for launch readiness before driving')
assert.ok(!run.cleanedAt)
requireLocal(run.url)
const safeFile = name => {
  assert.match(name, /^[a-z0-9-]+$/)
  return path.join(dir, `webkit-${name}`)
}

if (action === 'serve') {
  const browser = await webkit.launch({ headless: true })
  let touch = true
  let context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  let page = await context.newPage()
  page.setDefaultTimeout(15000)
  const visible = selector => page.locator(`${selector}:visible`)
  const locate = target => {
    const matches = target.selector ? visible(target.selector) : page.getByRole(target.role ?? 'button', { name: target.name, exact: true }).filter({ visible: true })
    return target.index == null ? matches : matches.nth(target.index)
  }
  const safeSnapshot = async () => {
    assert.equal(await page.locator('input[type="password"]:visible').evaluateAll(nodes => nodes.some(node => node.value)), false, 'Do not capture a populated password form')
    return page.locator('body').ariaSnapshot()
  }
  const execute = async (command, values) => {
    if (command === 'login') {
      const viewport = page.viewportSize()
      await context.close()
      touch = viewport.width < 960
      context = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch })
      page = await context.newPage()
      page.setDefaultTimeout(15000)
      await page.goto(run.url + '/sign-in')
      await page.waitForLoadState('networkidle')
      const state = JSON.parse(await readFile(path.join(run.work, 'tests/e2e-state.json'), 'utf8'))
      const user = state.users[Number(values[0] ?? 0)]
      assert.ok(user)
      await page.getByPlaceholder('you@example.com').filter({ visible: true }).fill(user.email)
      await page.getByPlaceholder('Your password').filter({ visible: true }).fill(state.password)
      await page.getByRole('button', { name: 'Sign In', exact: true }).filter({ visible: true }).click()
      await page.waitForURL(url => !url.pathname.includes('sign-in'))
      return 'Signed in through the form'
    }
    if (command === 'viewport') { await page.setViewportSize({ width: Number(values[0]), height: Number(values[1]) }); return page.viewportSize() }
    if (command === 'open') { const url = new URL(values[0], run.url); assert.equal(url.origin, run.url); await page.goto(url.href); return page.url() }
    if (command === 'click') {
      const target = locate(JSON.parse(values[0]))
      if (touch) await target.tap()
      else await target.click()
      return page.url()
    }
    if (command === 'fill') { const { value, ...target } = JSON.parse(values[0]); await locate(target).fill(value); return 'Filled visible control' }
    if (command === 'key') { await page.keyboard.press(values[0]); return 'Pressed key' }
    if (command === 'scroll') { await locate(JSON.parse(values[0])).scrollIntoViewIfNeeded(); return 'Scrolled visible control into view' }
    if (command === 'focus') { await locate(JSON.parse(values[0])).focus(); return 'Focused visible control' }
    if (command === 'back') { await page.goBack(); return page.url() }
    if (command === 'links') return await page.locator('[aria-label^="View "], [aria-label^="Open E2E"]').filter({ visible: true }).evaluateAll(nodes => nodes.map(node => ({ label: node.getAttribute('aria-label'), text: node.textContent, ancestors: [...(function* () { for (let parent = node.parentElement; parent; parent = parent.parentElement) yield parent })()].map(parent => parent.getAttribute('data-testid')).filter(Boolean) })))
    if (command === 'snapshot') return await safeSnapshot()
    if (command === 'observe') {
      const observed = await page.evaluate(() => ({
      url: location.href, width: innerWidth, touchPoints: navigator.maxTouchPoints, overflow: document.documentElement.scrollWidth > innerWidth,
      selectionLabels: [...document.querySelectorAll('[role="button"][aria-label^="Remove "]')].filter(node => node.getClientRects().length).map(node => node.getAttribute('aria-label')),
      focus: document.activeElement?.getAttribute('aria-label'),
      focusOutline: document.activeElement ? { style: getComputedStyle(document.activeElement).outlineStyle, width: getComputedStyle(document.activeElement).outlineWidth } : null,
      targets: [...document.querySelectorAll('[aria-label^="View "],[aria-label^="Add "],[aria-label^="Remove "]')].filter(node => node.getClientRects().length).map(node => ({ label: node.getAttribute('aria-label'), testID: node.getAttribute('data-testid'), selectionId: node.parentElement?.querySelector('[data-testid^="trade-"][data-testid*="-player-"]')?.getAttribute('data-testid'), selected: node.getAttribute('aria-selected') ?? node.getAttribute('aria-pressed'), disabled: node.getAttribute('aria-disabled'), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })),
      controls: [...document.querySelectorAll('input,textarea,[aria-selected],[aria-checked],[aria-pressed]')].filter(node => node.getClientRects().length).map(node => ({ label: node.getAttribute('aria-label'), placeholder: node.getAttribute('placeholder'), value: node.type === 'password' ? undefined : node.value, selected: node.getAttribute('aria-selected') ?? node.getAttribute('aria-pressed'), checked: node.getAttribute('aria-checked') })),
      scroll: [...document.querySelectorAll('*')].filter(node => node.getClientRects().length && (node.scrollHeight > node.clientHeight && node.clientHeight > 100 && getComputedStyle(node).overflowY.match(/auto|scroll/) || node.scrollWidth > node.clientWidth && node.clientWidth > 100 && getComputedStyle(node).overflowX.match(/auto|scroll/))).map(node => ({ top: Math.round(node.scrollTop), left: Math.round(node.scrollLeft), height: node.clientHeight, width: node.clientWidth })),
      nested: [...document.querySelectorAll('[role="button"],[role="link"]')].filter(node => node.querySelector('[role="button"],[role="link"],button,a[href]') && node.getClientRects().length).map(node => node.getAttribute('aria-label')),
      }))
      return { ...observed, inputMode: touch ? 'touch' : 'mouse' }
    }
    if (command === 'capture') {
      const file = safeFile(values[0])
      await page.waitForTimeout(400)
      const snapshot = await safeSnapshot()
      await page.screenshot({ path: file + '.png', fullPage: true, animations: 'disabled' })
      await writeFile(file + '.txt', snapshot)
      return file + '.png'
    }
    throw new Error('Unknown WebKit command')
  }
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST')
      let body = ''
      for await (const chunk of req) { body += chunk; assert.ok(body.length < 16384) }
      const { command, values = [] } = JSON.parse(body)
      const result = await execute(command, values)
      await appendFile(path.join(dir, 'webkit-actions.log'), `${new Date().toISOString()} ${command}\n`)
      res.end(JSON.stringify({ result }))
    } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })) }
  })
  server.listen(0, '127.0.0.1', async () => {
    await writeFile(path.join(dir, 'webkit-port.json'), JSON.stringify({ port: server.address().port }))
    console.log('WebKit control ready')
  })
  process.on('SIGTERM', () => { void browser.close().finally(() => server.close(() => process.exit())) })
} else {
  const { port } = JSON.parse(await readFile(path.join(dir, 'webkit-port.json'), 'utf8'))
  const result = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: JSON.stringify({ command: action, values: args }) }).then(response => response.json())
  assert.ok(!result.error, result.error)
  console.log(typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2))
}
