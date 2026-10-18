import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium, webkit } from 'playwright'

const directory = `${process.env.TASK_DIR}/evidence/stage2/lane-b/push-rotation`
await mkdir(directory, { recursive: true })
const stubs = {
  '@/lib/shared/api': `export async function apiPost(path, body, options) {
    await options?.beforeSend?.();
    if (path.endsWith('/config')) return {publicKey:'AQIDBA'};
    Reflect.get(window, 'pushReceipts').push({path, body, owner:options?.expectedUserId});
    return {applied:true,generation:++window.pushGeneration,revocationCredential:'a'.repeat(43)};
  }`,
  '@/lib/session-cache-registry': `export const sessionOwner = () => window.fixtureOwner; export const sessionGeneration = () => 1;`,
  '@/hooks/use-auth': `export const useAuth = () => ({user:{id:window.fixtureOwner}});`,
  'expo-router': `export const useRouter = () => ({push(){}});`,
}
const javascript = (await build({ entryPoints: ['tests/e2e/pwa-push-probe.tsx'], bundle: true, write: false, format: 'esm', platform: 'browser',
  alias: { 'react-native': 'react-native-web' }, define: { 'process.env': '{"NODE_ENV":"production","EXPO_OS":"web","EXPO_PUBLIC_SUPABASE_URL":"local-push-fixture"}', __DEV__: 'false', global: 'globalThis' },
  plugins: [{ name: 'local-push-authority', setup(build) {
    build.onResolve({ filter: /.*/ }, args => stubs[args.path] ? { path: args.path, namespace: 'fixture' } : undefined)
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }))
  } }] })).outputFiles[0].text
const server = createServer((request, response) => {
  if (request.url === '/probe.mjs') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(javascript) }
  else { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html><body><div id="root"></div><script type="module" src="/probe.mjs"></script></body></html>') }
})
await new Promise(resolve => server.listen(56855, '127.0.0.1', () => resolve(undefined)))
const results = []
try {
  for (const engine of ['chromium', 'webkit']) {
    const context = await (engine === 'chromium' ? chromium : webkit).launchPersistentContext(`${directory}/${engine}-${Date.now()}`, { headless: true })
    const page = await context.newPage()
    const result = { engine, errors: [] }
    results.push(result)
    page.on('pageerror', error => result.errors.push(String(error)))
    try {
      await context.addInitScript(() => {
        const state = Object.assign(window, { fixtureOwner: 'synthetic-owner', pushReceipts: [], pushGeneration: 0, permissionRequests: 0, currentEndpoint: 'https://push.fixture.test/first' })
        const subscription = () => ({ endpoint: state.currentEndpoint, options: { applicationServerKey: new Uint8Array([1, 2, 3, 4]).buffer },
          toJSON: () => ({ keys: { p256dh: 'synthetic-key', auth: 'synthetic-auth' } }), unsubscribe: async () => true })
        const registration = { pushManager: { getSubscription: async () => subscription(), subscribe: async () => subscription() } }
        const worker = Object.assign(new EventTarget(), { ready: Promise.resolve(registration), getRegistration: async () => registration })
        Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker })
        Object.defineProperty(window, 'PushManager', { configurable: true, value: function () {} })
        Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'granted', requestPermission: async () => { state.permissionRequests++; return 'granted' } } })
      })
      await page.goto('http://127.0.0.1:56855')
      await page.waitForFunction(() => Reflect.get(window, 'pushProbeReady'))
      assert.equal(await page.evaluate(() => Reflect.get(window, 'pushProbe').enable()), 'on')
      await page.evaluate(() => { Object.assign(window, { pushReceipts: [], currentEndpoint: 'https://push.fixture.test/rotated' }); navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'PANCAKE_PUSH_SUBSCRIPTION_CHANGED' } })) })
      await page.waitForFunction(() => Reflect.get(window, 'pushReceipts').some(receipt => receipt.path.endsWith('/subscribe') && receipt.body.endpoint.endsWith('/rotated')))
      result.rotated = await page.evaluate(() => { const receipt = Reflect.get(window, 'pushReceipts').find(receipt => receipt.path.endsWith('/subscribe')); return { endpoint: receipt.body.endpoint, owner: receipt.owner } })
      assert.equal(result.rotated.owner, 'synthetic-owner')
      assert.equal(await page.evaluate(() => Reflect.get(window, 'permissionRequests')), 1)
      await page.evaluate(() => Reflect.get(window, 'pushProbe').disable())
      await page.evaluate(() => { Object.assign(window, { pushReceipts: [], currentEndpoint: 'https://push.fixture.test/disabled-rotation' }); navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'PANCAKE_PUSH_SUBSCRIPTION_CHANGED' } })); window.dispatchEvent(new Event('online')) })
      await page.waitForTimeout(300)
      assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'pushReceipts')), [])
      result.disabledRemainsClosed = true
      assert.deepEqual(result.errors, [])
      result.passed = true
    } catch (error) { result.failure = String(error) }
    finally { await context.close(); console.log(engine, result.failure ?? 'passed'); await writeFile(`${directory}/results.json`, JSON.stringify(results, null, 2)) }
  }
} finally { await new Promise(resolve => server.close(resolve)) }
assert(results.every(result => result.passed), JSON.stringify(results))
