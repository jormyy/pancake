import assert from 'node:assert/strict'
import { playerViewReady } from './player-results.mjs'

export function actionKind(spec) {
  const kinds = ['sequence', 'tap', 'tapPrefix', 'fill', 'select', 'open', 'offline', 'background', 'reveal', 'revealText', 'scrollEnd', 'pullRefresh', 'timer'].filter(key => spec[key] !== undefined)
  assert.equal(kinds.length, 1, 'Each screen action needs one supported operation')
  if (kinds[0] === 'sequence') for (const child of spec.sequence) actionKind(child)
  return kinds[0]
}

async function labeled(page, label, prefix = false, dialog) {
  const modal = page.getByRole('dialog').filter({ visible: true }).last()
  const root = dialog ? page.getByRole('dialog', { name: dialog, exact: true }) : await modal.count() ? modal : page
  const attribute = `[aria-label${prefix ? '^' : ''}=${JSON.stringify(label)}]:visible`
  const name = prefix ? new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) : label
  const interactive = root.getByRole('button', { name, exact: !prefix }).or(root.getByRole('link', { name, exact: !prefix }))
  const fallback = root.locator(attribute)
  await interactive.or(fallback).filter({ visible: true }).first().waitFor({ state: 'visible' })
  if (await interactive.filter({ visible: true }).count()) return interactive.filter({ visible: true }).first()
  return fallback.first()
}

async function executeAction(page, context, origin, spec, hooks, trace) {
  const kind = actionKind(spec)
  if (kind === 'sequence') { for (const [index, child] of spec.sequence.entries()) await performAction(page, context, origin, child, hooks, `${trace}.${index}`); return }
  if (kind === 'tap' || kind === 'tapPrefix') { await (await labeled(page, spec[kind], kind === 'tapPrefix', spec.dialog)).click(); return }
  if (kind === 'fill') {
    const field = page.getByLabel(spec.fill, { exact: true }).or(page.getByPlaceholder(spec.fill, { exact: true })).first()
    if (/search/i.test(spec.fill)) {
      await field.fill('')
      for (const [index, character] of [...spec.value].entries()) {
        await hooks?.keystroke?.(spec, trace, index, spec.value.slice(0, index + 1))
        await field.pressSequentially(character)
        if (index + 1 < spec.value.length) await page.waitForTimeout(spec.cadenceMs ?? 180)
      }
    } else await field.fill(spec.value)
    await field.blur()
    return
  }
  if (kind === 'select') { await (await labeled(page, spec.select)).selectOption({ label: spec.option ?? spec.value }); return }
  if (kind === 'open') {
    const target = new URL(spec.open, origin)
    assert.equal(target.origin, new URL(origin).origin, 'Screen navigation must stay on the local gateway')
    await page.goto(target.href)
    return
  }
  if (kind === 'timer') { await page.waitForTimeout(spec.timer); return }
  if (kind === 'pullRefresh') {
    await page.locator(spec.pullRefresh).evaluate(element => {
      const scroll = [element, ...element.querySelectorAll('*')].find(node => node.scrollHeight > node.clientHeight && node.clientHeight > 100)
      if (scroll) scroll.scrollTop = 0
      const rect = element.getBoundingClientRect()
      const target = document.elementFromPoint(rect.left + rect.width / 2, Math.max(130, rect.top + 80)) ?? element
      const touch = y => ({ identifier: 1, target, clientX: rect.left + rect.width / 2, clientY: y, pageX: rect.left + rect.width / 2, pageY: y })
      for (const { type, y } of [{ type: 'touchstart', y: 200 }, { type: 'touchmove', y: 320 }, { type: 'touchend', y: 320 }]) {
        const points = type === 'touchend' ? [] : [touch(y)]
        const event = new Event(type, { bubbles: true, cancelable: true })
        for (const [key, value] of Object.entries({ touches: points, targetTouches: points, changedTouches: [touch(y)] })) Object.defineProperty(event, key, { value })
        target.dispatchEvent(event)
      }
    })
    return
  }
  if (kind === 'offline') { await context.setOffline(true); return }
  if (kind === 'background') {
    const background = await context.newPage()
    await background.bringToFront()
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await background.close()
    await page.bringToFront()
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')) })
    return
  }
  if (kind === 'reveal') { await (await labeled(page, spec.reveal)).scrollIntoViewIfNeeded(); return }
  if (kind === 'revealText') { await page.getByText(spec.revealText, { exact: true }).filter({ visible: true }).first().scrollIntoViewIfNeeded(); return }
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('body *')) {
      if (element.scrollHeight > element.clientHeight + 50 && element.clientHeight > 200 && ['auto', 'scroll'].includes(getComputedStyle(element).overflowY)) element.scrollTop = element.scrollHeight
    }
    window.scrollTo(0, document.body.scrollHeight)
  })
}

export async function expectContent(page, expected, origin) {
  let asserted = false
  if (expected.all) {
    assert.ok(expected.all.length, 'An all-content contract cannot be empty')
    for (const item of expected.all) await expectContent(page, item, origin)
    asserted = true
  }
  if (expected.any) {
    assert.ok(expected.any.length, 'An any-content contract cannot be empty')
    await Promise.any(expected.any.map(item => expectContent(page, item, origin)))
    asserted = true
  }
  if (expected.route) {
    const target = new URL(expected.route, origin)
    await page.waitForURL(url => url.pathname === target.pathname && (!target.search || url.search === target.search))
  }
  if (expected.selector) {
    await page.locator(expected.selector).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 15000 })
    asserted = true
  }
  if (expected.value !== undefined) {
    const value = typeof expected.value === 'object' && expected.value !== null ? expected.value : { selector: expected.selector, equals: expected.value }
    assert.equal(typeof value.selector, 'string', 'A value assertion needs an input selector')
    assert.ok(value.equals !== undefined, 'A value assertion needs an expected value')
    const input = page.locator(value.selector).filter({ visible: true }).first()
    await input.waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await input.inputValue(), String(value.equals))
    asserted = true
  }
  if (expected.text) {
    const scope = expected.within ? page.locator(expected.within).filter({ visible: true }).first() : page
    await scope.getByText(expected.text, { exact: false }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 15000 })
    asserted = true
  }
  if (expected.dialog) { await page.getByRole('dialog', { name: expected.dialog }).waitFor({ state: 'visible', timeout: 15000 }); asserted = true }
  if (expected.button) {
    const scope = expected.dialog ? page.getByRole('dialog', { name: expected.dialog, exact: true }) : page
    await scope.getByRole('button', { name: expected.button, exact: true }).waitFor({ state: 'visible', timeout: 15000 })
    asserted = true
  }
  if (expected.absentText) {
    await page.getByText(expected.absentText, { exact: false }).filter({ visible: true }).first().waitFor({ state: 'hidden', timeout: 15000 })
    asserted = true
  }
  if (expected.playerView) {
    await page.waitForFunction(playerViewReady, expected.playerView, { timeout: 15000 })
    asserted = true
  }
  assert.ok(asserted, 'A screen needs visible content evidence')
}

export async function performAction(page, context, origin, spec, hooks, trace = '0') {
  if (spec.sequence) return executeAction(page, context, origin, spec, hooks, trace)
  await hooks?.before?.(spec, trace)
  let succeeded = false
  try { const result = await executeAction(page, context, origin, spec, hooks, trace); succeeded = true; return result }
  finally { await hooks?.after?.(spec, trace, succeeded) }
}
