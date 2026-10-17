import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WEB_TARGETS, openWebTarget, pressWebControl, readWebLayout, navigateWebTarget, reloadWebTarget } from './web-targets-browser.mjs'

const sessions = new Map()
const currentTarget = () => {
  const target = WEB_TARGETS.find((value) => value.id === process.env.E2E_WEB_TARGET_ID)
  assert.ok(target, 'Browser target must be a supported web setup')
  return target
}
export const listWebTargetBrowserSessions = () => [...sessions.keys()].join('\n')

async function sessionFor(name) {
  if (sessions.has(name)) return sessions.get(name)
  const target = currentTarget()
  const dir = path.resolve(process.env.E2E_BROWSER_ARTIFACT_DIR, 'clients', name)
  await mkdir(dir, { recursive: true })
  const client = await openWebTarget(target, dir)
  const state = { ...client, target, dir, refs: new Map(), console: [], errors: [], requests: [], commands: [] }
  client.page.on('console', (message) => state.console.push(`[${message.type()}] ${message.location().url} ${message.text()}`))
  client.page.on('pageerror', (error) => state.errors.push(error.message))
  client.page.on('request', (request) => state.requests.push({ method: request.method(), url: request.url() }))
  client.page.on('dialog', (dialog) => dialog.accept())
  sessions.set(name, state)
  return state
}

async function snapshot(state) {
  state.refs.clear()
  const tree = await state.page.locator('body').ariaSnapshot()
  const seen = new Map()
  return tree.split('\n').map((line) => {
    const match = line.match(/^\s*- (button|textbox|link|tab|checkbox|switch|combobox) "((?:\\.|[^"\\])*)"/)
    if (!match) return line
    const [, role, encoded] = match
    const name = JSON.parse(`"${encoded}"`)
    const key = `${role}:${name}`
    const index = seen.get(key) ?? 0
    seen.set(key, index + 1)
    const ref = `e${state.refs.size + 1}`
    state.refs.set(ref, state.page.locator(`role=${role}[name=${JSON.stringify(name)}]`).nth(index))
    const rest = line.slice(match[0].length)
    const flags = rest.match(/^(?: \[[^\]]*\])*/)[0]
    const states = flags ? flags.slice(2, -1).replace(/\] \[/g, ', ') : ''
    return `${match[0]} [${states ? `${states}, ` : ''}ref=${ref}]${rest.slice(flags.length)}`
  }).join('\n')
}

async function inspect(state) {
  const layout = await readWebLayout(state.page, state.target.insets)
  assert.equal(layout.client.width, state.target.viewport.width)
  assert.equal(layout.client.height, state.target.viewport.height)
  assert.ok(layout.overflow <= 1, `Horizontal overflow: ${layout.overflow}px`)
  for (const input of layout.inputs) assert.ok(input.font >= 16, `${input.label}: ${input.font}px text input`)
  return layout
}

async function evaluate(state, source) {
  if (!/\.(?:click|dispatchEvent)\s*\(/.test(source)) return state.page.evaluate(source)
  const value = await state.page.evaluate(async (source) => {
    const original = HTMLElement.prototype.click
    const originalDispatch = EventTarget.prototype.dispatchEvent
    const clicks = []
    const select = (node) => { if (!clicks.includes(node)) clicks.push(node) }
    HTMLElement.prototype.click = function () { select(this) }
    EventTarget.prototype.dispatchEvent = function (event) {
      if (this instanceof HTMLElement && /^(?:click|pointerdown|pointerup|mousedown|mouseup)$/.test(event.type)) { select(this); return true }
      return originalDispatch.call(this, event)
    }
    try { return await (0, eval)(source) }
    finally {
      HTMLElement.prototype.click = original
      EventTarget.prototype.dispatchEvent = originalDispatch
      Reflect.set(window, '__webActionClickTargets', clicks)
    }
  }, source)
  const count = await state.page.evaluate(() => Reflect.get(window, '__webActionClickTargets').length)
  assert.ok(count <= 1, 'A legacy step must select at most one control for a real pointer action')
  if (count) {
    const handle = await state.page.evaluateHandle(() => Reflect.get(window, '__webActionClickTargets')[0])
    try {
      const element = handle.asElement()
      assert.ok(element, 'The selected control must remain in the document')
      await element.scrollIntoViewIfNeeded()
      await pressWebControl(state.target, element)
      assert.equal(await state.page.evaluate(() => Reflect.get(window, '__webTargetPointer')), state.target.mobile ? 'touch' : 'mouse')
      assert.equal(await state.page.evaluate(() => Reflect.get(window, '__webTargetPointerTrusted')), true)
    } finally { await handle.dispose() }
  }
  await state.page.evaluate(() => Reflect.deleteProperty(window, '__webActionClickTargets'))
  return value
}

export async function runWebTargetBrowserCommand({ session, args }) {
  if (args[0] === 'close' && !sessions.has(session)) return 'Closed'
  const state = await sessionFor(session)
  const { page, target } = state
  const locator = (ref) => state.refs.get(ref.replace(/^@/, '')) ?? page.locator(ref)
  const press = (control) => pressWebControl(target, control)
  let output = ''
  switch (args[0]) {
    case 'open': {
      assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(args[1]).hostname), 'Web actions require a local frontend')
      await navigateWebTarget(page, args[1])
      break
    }
    case 'reload': await reloadWebTarget(page); break
    case 'wait':
      if (args[1] === '--fn') await page.waitForFunction(args[2])
      else await page.waitForTimeout(Number(args[1]))
      break
    case 'eval': output = JSON.stringify(await evaluate(state, args[1])) ?? 'null'; break
    case 'snapshot': output = await snapshot(state); break
    case 'fill': await locator(args[1]).fill(args[2]); break
    case 'fill-label': await page.getByLabel(args[1], { exact: true }).fill(args[2]); break
    case 'click': await press(locator(args[1])); break
    case 'press': await page.keyboard.press(args[1]); break
    case 'get': assert.equal(args[1], 'url'); output = page.url(); break
    case 'find': {
      if (args[1] === 'placeholder') {
        assert.equal(args[3], 'fill')
        await page.getByPlaceholder(args[2], { exact: true }).fill(args[4])
        break
      }
      assert.equal(args[1], 'role')
      assert.equal(args[3], 'click')
      const index = args.indexOf('--name')
      assert.ok(index > 0)
      await press(page.locator(`role=${args[2]}[name=${JSON.stringify(args[index + 1])}]`).last())
      break
    }
    case 'set': {
      assert.equal(args[1], 'viewport')
      output = JSON.stringify({ requested: args.slice(2), actual: target.viewport })
      break
    }
    case 'screenshot': await page.screenshot({ path: args[1], fullPage: args.includes('--full') }); break
    case 'console': output = state.console.join('\n'); break
    case 'errors': output = state.errors.join('\n'); break
    case 'network': output = JSON.stringify(state.requests); break
    case 'close': {
      await writeFile(path.join(state.dir, 'client.json'), `${JSON.stringify({ target, commands: state.commands, console: state.console, errors: state.errors, requests: state.requests }, null, 2)}\n`)
      await state.context.close()
      await state.browser.close()
      sessions.delete(session)
      return 'Closed'
    }
    default: throw new Error(`Unsupported web browser command: ${args[0]}`)
  }
  const detail = ['snapshot', 'click', 'fill'].includes(args[0]) ? await inspect(state) : null
  state.commands.push({ command: args[0], viewport: page.viewportSize(), ...(detail ? { layout: detail } : {}) })
  return output
}
