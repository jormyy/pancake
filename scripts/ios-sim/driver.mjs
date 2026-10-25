import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, open, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { freePort, home, json, lock, pause, readJson, ready, run, stopChild } from './common.mjs'

export class Driver {
  constructor(port) { this.url = `http://127.0.0.1:${port}`; this.context = 'NATIVE_APP'; this.id = ''; this.child = null }
  async request(method, route, body, timeout = 120000) {
    const response = await fetch(`${this.url}${route.startsWith('/session') || route === '/status' ? route : `/session/${this.id}${route}`}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) })
    const result = await response.json()
    if (!response.ok || result.value?.error) throw new Error(`${method} ${route}: ${result.value?.message ?? response.status}`)
    return result.value
  }
  async execute(script, ...args) { return this.request('POST', '/execute/sync', { script, args }) }
  async mobile(command, value = {}) { return this.execute(`mobile: ${command}`, value) }
  async native() { await this.request('POST', '/context', { name: 'NATIVE_APP' }); this.context = 'NATIVE_APP' }
  async web(origin, standalone = false, timeout = 25000) {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const contexts = await this.request('GET', '/contexts')
      for (const name of contexts.filter(value => value !== 'NATIVE_APP')) {
        try {
          await this.request('POST', '/context', { name })
          const current = await this.execute('return {url: location.origin, standalone: navigator.standalone === true || matchMedia("(display-mode: standalone)").matches}')
          if (current.url === origin && (!standalone || current.standalone)) { this.context = name; return true }
        } catch {}
      }
      await pause(600)
    }
    await this.native()
    return false
  }
  async find(value, using = 'accessibility id') {
    if (using === 'accessibility id' && this.context === 'NATIVE_APP') {
      using = '-ios predicate string'
      value = `(name == ${JSON.stringify(value)} OR label == ${JSON.stringify(value)}) AND visible == true AND enabled == true`
    }
    const result = await this.request('POST', '/element', { using, value })
    return result['element-6066-11e4-a52e-4f735466cecf'] ?? result.ELEMENT
  }
  async click(value, using = 'accessibility id') {
    const id = await this.find(value, using)
    return this.request('POST', `/element/${id}/click`, {})
  }
  async optional(value, using) { try { await this.click(value, using); return true } catch { return false } }
  async screenshot(file) { await writeFile(file, Buffer.from(await this.request('GET', '/screenshot'), 'base64')) }
  async source(file) { await writeFile(file, await this.request('GET', '/source')) }
  async close() { if (this.id) await this.request('DELETE', `/session/${this.id}`).catch(() => {}); await stopChild(this.child) }
}

export async function simulator(name) {
  return lock(path.join(home, 'devices.lock'), async () => {
  assert.ok(typeof name === 'string' && name.length > 0 && !/[\r\n]/.test(name), 'A simulator device name is required')
  const data = JSON.parse(await run('xcrun', ['simctl', 'list', 'devices', 'available', '-j']))
  const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5'
  assert.ok(data.devices[runtime], 'Install the iOS 26.5 Simulator runtime')
  const manifestFile = path.join(home, 'devices.json')
  const owned = await readJson(manifestFile) ?? {}
  let device = data.devices[runtime].find(value => value.name === name)
  if (device) assert.equal(owned[name], device.udid, 'This device belongs to someone else. Use a new name.')
  else {
    const udid = await run('xcrun', ['simctl', 'create', name, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', runtime])
    owned[name] = udid
    await json(manifestFile, owned)
    device = { name, udid, state: 'Shutdown' }
  }
  assert.notEqual(device.state, 'Booted', 'Owned simulator is already booted. Wait for its runner to finish.')
  try {
    await run('xcrun', ['simctl', 'boot', device.udid])
    await run('xcrun', ['simctl', 'bootstatus', device.udid, '-b'])
    await run('xcrun', ['simctl', 'status_bar', device.udid, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--batteryState', 'charged', '--batteryLevel', '100'])
    return device
  } catch (error) {
    await run('xcrun', ['simctl', 'shutdown', device.udid]).catch(() => {})
    throw error
  }
  })
}

export async function startDriver({ device, port, directory }) {
  for (const value of [port, port + 1, port + 2]) await freePort(value)
  await mkdir(directory, { recursive: true })
  const driver = new Driver(port)
  const log = await open(path.join(directory, 'appium.log'), 'a')
  const appium = await run('/usr/bin/which', ['appium'])
  driver.child = spawn(appium, ['--address', '127.0.0.1', '--port', String(port), '--log-no-colors'], { stdio: ['ignore', log.fd, log.fd] })
  await log.close()
  try {
    await ready(`${driver.url}/status`, driver.child)
    const session = await driver.request('POST', '/session', { capabilities: { alwaysMatch: {
      platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': device.udid,
      'appium:deviceName': device.name, 'appium:platformVersion': '26.5',
      'appium:noReset': true, 'appium:newCommandTimeout': 180, 'appium:includeSafariInWebviews': true,
      'appium:additionalWebviewBundleIds': ['*'], 'appium:showXcodeLog': true,
      'appium:wdaLocalPort': port + 1, 'appium:mjpegServerPort': port + 2,
      'appium:derivedDataPath': path.join(home, 'wda', device.udid), 'appium:waitForIdleTimeout': 0,
      'appium:enablePerformanceLogging': true, 'appium:safariIgnoreWebHostnames': 'www.apple.com',
    } } }, 240000)
    driver.id = session.sessionId
    await driver.request('POST', '/timeouts', { implicit: 2000 })
    return driver
  } catch (error) { await driver.close(); throw error }
}

export async function installPwa(driver, { device, origin, title, directory }) {
  await driver.mobile('pressButton', { name: 'home' })
  let existing = false
  for (let page = 0; page < 3; page++) {
    if (await driver.optional(title)) { existing = true; break }
    await driver.mobile('swipe', { direction: 'left' })
  }
  if (existing && await driver.web(origin, true)) {
    await driver.native()
    await driver.screenshot(path.join(directory, 'home-screen-launch.png'))
    await driver.source(path.join(directory, 'home-screen-launch.xml'))
    return true
  }
  await driver.native()
  await driver.mobile('activateApp', { bundleId: 'com.apple.mobilesafari' })
  await run('xcrun', ['simctl', 'openurl', device.udid, `${origin}/sign-in`])
  await pause(2000)
  for (const label of ['Continue', 'Start Browsing', 'Not Now']) await driver.optional(label)
  await driver.source(path.join(directory, 'safari-before-install.xml'))
  await driver.screenshot(path.join(directory, 'safari-before-install.png'))
  await driver.optional('xmark.circle.fill')
  if (!await driver.optional('ShareButton') && !await driver.optional('Share')) {
    await driver.click('MoreMenuButton')
    await driver.optional('xmark.circle.fill')
    await driver.click('ShareButton')
  }
  await driver.source(path.join(directory, 'share-sheet.xml'))
  if (!await driver.optional('Add to Home Screen')) {
    await driver.optional('View More')
    await pause(800)
    await driver.click('Add to Home Screen')
  }
  let addReady = false
  for (let attempt = 0; attempt < 4; attempt++) {
    await pause(800)
    try { await driver.find('type == "XCUIElementTypeButton" AND name == "Add" AND enabled == true AND visible == true', '-ios predicate string'); addReady = true; break } catch {}
    await driver.optional('Add to Home Screen')
  }
  assert.ok(addReady, 'The Add to Home Screen form did not open')
  await driver.source(path.join(directory, 'add-to-home-screen.xml'))
  const field = await driver.find('type == "XCUIElementTypeTextField" AND label == "" AND visible == true', '-ios predicate string')
  await driver.request('POST', `/element/${field}/clear`, {})
  await driver.request('POST', `/element/${field}/value`, { text: title })
  await driver.click('Add')
  await pause(1500)
  await driver.mobile('pressButton', { name: 'home' })
  await pause(600)
  let launched = false
  for (let page = 0; page < 4; page++) {
    if (await driver.optional(title)) { launched = true; break }
    await driver.mobile('swipe', { direction: 'left' })
  }
  assert.ok(launched, 'The installed Home Screen icon is not visible')
  await driver.screenshot(path.join(directory, 'home-screen-launch.png'))
  await driver.source(path.join(directory, 'home-screen-launch.xml'))
  const web = await driver.web(origin, true)
  if (web) assert.equal(await driver.execute('return navigator.standalone === true || matchMedia("(display-mode: standalone)").matches'), true)
  return web
}
