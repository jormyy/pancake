import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { webkit } from 'playwright'
import { networkProxy } from '../../scripts/perf-lab/network-proxy.mjs'
import { labRoot, requireMini, json } from '../../scripts/perf-lab/common.mjs'
import { command } from '../../scripts/perf-lab/process.mjs'

export async function checkBrowserCacheProxy() {
  await requireMini()
  const hostname = (await command('scutil', ['--get', 'LocalHostName'])).stdout.trim().toLowerCase() + '.local'
  let scripts = 0, proxy, browser
  const server = https.createServer({ key: await readFile(path.join(labRoot, 'certs/server-key.pem')), cert: await readFile(path.join(labRoot, 'certs/server.pem')) }, (request, response) => {
    if (request.url === '/cached.js') {
      scripts++
      response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=3600, immutable' })
      response.end('window.proxyMarker = true')
    } else {
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      response.end('<main>Cache probe</main><script src="/cached.js"></script>')
    }
  })
  const measure = async routed => {
    const start = scripts
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    try {
      if (routed) await context.route('**/*', route => route.continue())
      const page = await context.newPage()
      for (const url of ['/one', '/two']) {
        await page.goto(`https://${hostname}:57286${url}`)
        await page.waitForFunction(() => window.proxyMarker === true)
      }
      if (!routed) await assert.rejects(page.goto('https://example.invalid', { timeout: 5000 }))
      return scripts - start
    } finally { await context.close() }
  }
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(57286, '127.0.0.1', () => resolve(undefined)) })
    proxy = await networkProxy(`https://${hostname}:57286`)
    browser = await webkit.launch({ headless: true, proxy: { server: proxy.url } })
    const cacheEnabled = await measure(false)
    const routingEnabled = await measure(true)
    assert.equal(cacheEnabled, 1)
    assert.equal(routingEnabled, 2)
    assert.ok(proxy.blocked.some(row => row.host === 'example.invalid'))
    const result = { passed: true, cacheEnabledScriptRequests: cacheEnabled, routingEnabledScriptRequests: routingEnabled, externalBlocked: true }
    await json(path.join(labRoot, 'capture-smoke/evidence/network-cache.json'), result)
    return 'Proxy blocks external traffic and preserves HTTP caching; routing negative control disables it'
  } finally {
    await browser?.close()
    await proxy?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await checkBrowserCacheProxy())
