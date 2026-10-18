import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { build as bundle } from 'esbuild'
import { chromium, webkit, devices } from 'playwright'

process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1'
const root = process.env.TASK_DIR
const directory = `${root}/evidence/stage2/lane-b/${process.env.PWA_RUN_NAME ?? 'visual'}`
await mkdir(directory, { recursive: true })
const glyphs = JSON.parse(await readFile('assets/fonts/MaterialIcons.glyphs.json', 'utf8'))
const original = await readFile('node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/MaterialIcons.ttf')
const subset = await readFile('assets/fonts/MaterialIcons.woff2')
const motion = (await bundle({ entryPoints: ['tests/e2e/pwa-motion-probe.tsx'], write: false, bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic',
  alias: { 'react-native': 'react-native-web' }, resolveExtensions: ['.web.tsx', '.tsx', '.web.ts', '.ts', '.web.js', '.js', '.json'],
  define: { 'process.env': '{"NODE_ENV":"production","EXPO_OS":"web"}', __DEV__: 'false', global: 'globalThis' }, loader: { '.js': 'jsx', '.ttf': 'dataurl', '.png': 'dataurl' } })).outputFiles[0].text
let variant = 'before'
let delayed = true
const origin = 'http://127.0.0.1:56854'
const server = createServer((request, response) => {
  const pathname = new URL(request.url, origin).pathname
  const fixed = pathname === '/_original.ttf' ? { body: original, type: 'font/ttf' } : pathname === '/_subset.woff2' ? { body: subset, type: 'font/woff2' } :
    pathname === '/_motion.mjs' ? { body: motion, type: 'text/javascript' } : pathname === '/_motion' ? { body: '<html><body><div id="root"></div><script type="module" src="/_motion.mjs"></script></body></html>', type: 'text/html' } : null
  if (fixed) { response.writeHead(200, { 'content-type': fixed.type }); response.end(fixed.body); return }
  const forward = httpRequest({ hostname: '127.0.0.1', port: variant === 'before' ? 56850 : 56851, path: request.url,
    headers: { ...request.headers, host: '127.0.0.1' } }, incoming => {
    const parts = []
    incoming.on('data', chunk => parts.push(chunk))
    incoming.on('end', () => {
      const send = () => { response.writeHead(incoming.statusCode, incoming.headers); response.end(Buffer.concat(parts)) }
      if (delayed && /\.(ttf|woff2)$/.test(pathname)) setTimeout(send, 7000)
      else send()
    })
  })
  forward.on('error', error => { response.writeHead(502); response.end(String(error)) })
  forward.end()
})
await new Promise(resolve => server.listen(56854, '127.0.0.1', () => resolve(undefined)))
const results = []
try {
  for (const engine of ['chromium', 'webkit']) {
    for (const build of ['before', 'after']) {
      variant = build
      delayed = true
      const context = await (engine === 'chromium' ? chromium : webkit).launchPersistentContext(`${directory}/${engine}-${build}-${Date.now()}`, {
        headless: true, ...(engine === 'webkit' ? devices['iPhone 13'] : { viewport: { width: 1280, height: 900 } }),
      })
      const page = await context.newPage()
      const result = { engine, build, errors: [] }
      results.push(result)
      page.on('pageerror', error => result.errors.push(String(error)))
      try {
        await page.goto(origin, { waitUntil: 'domcontentloaded' })
        const heading = page.getByText('Welcome back', { exact: true })
        await heading.waitFor()
        result.pending = await page.evaluate(() => ({ atMs: performance.now(), fonts: document.fonts.status,
          fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
          displays: [...document.fonts].map(face => ({ family: face.family, display: face.display, status: face.status })) }))
        await page.screenshot({ path: `${directory}/${engine}-${build}-fonts-pending.png` })
        await heading.screenshot({ path: `${directory}/${engine}-${build}-heading-pending.png` })
        await page.evaluate(() => document.fonts.ready)
        result.loaded = await page.evaluate(() => [...document.fonts].map(face => ({ family: face.family, status: face.status })))
        const outfit = result.loaded.filter(face => face.family.startsWith('Outfit'))
        assert.equal(outfit.length, 3)
        assert(outfit.every(face => face.status === 'loaded'), JSON.stringify(outfit))
        delayed = false
        await page.screenshot({ path: `${directory}/${engine}-${build}-fonts-loaded.png` })
        if (build === 'after') {
          assert(result.pending.displays.filter(face => face.family.startsWith('Outfit')).every(face => face.display === 'swap'))
          assert.equal(result.pending.fonts, 'loading')
          result.glyphs = await page.evaluate(async glyphs => {
            for (const [family, url] of [['OriginalIcons', '/_original.ttf'], ['SubsetIcons', '/_subset.woff2']]) {
              const face = new FontFace(family, `url(${url})`)
              document.fonts.add(await face.load())
            }
            const draw = (family, value) => {
              const canvas = document.createElement('canvas')
              canvas.width = 48; canvas.height = 48
              const ctx = canvas.getContext('2d')
              ctx.font = `24px ${family}`
              ctx.fillText(String.fromCodePoint(value), 8, 34)
              return canvas.toDataURL()
            }
            return Object.entries(glyphs).map(([name, value]) => ({ name, equal: draw('OriginalIcons', value) === draw('SubsetIcons', value) }))
          }, glyphs)
          assert(result.glyphs.every(glyph => glyph.equal))
          await page.goto(`${origin}/_motion`)
          const press = page.locator('#motion-press')
          await press.waitFor()
          if (engine === 'chromium') {
            await press.hover()
            await page.waitForTimeout(500)
            result.hoverTransform = await press.evaluate(element => getComputedStyle(element).transform)
          }
          const box = await press.boundingBox()
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          await page.mouse.down()
          await page.waitForTimeout(300)
          result.pressTransform = await press.evaluate(element => getComputedStyle(element).transform)
          assert.notEqual(result.pressTransform, 'matrix(1, 0, 0, 1, 0, 0)')
          await page.mouse.up()
          await page.getByText('Saved for test', { exact: true }).waitFor()
          await page.getByRole('button', { name: 'Dismiss', exact: true }).click()
          await page.getByText('Saved for test', { exact: true }).waitFor({ state: 'hidden' })
          const ring = page.locator('#pulse > div > div').first()
          const start = await ring.evaluate(element => getComputedStyle(element).transform)
          await page.waitForTimeout(400)
          const end = await ring.evaluate(element => getComputedStyle(element).transform)
          assert.notEqual(start, end)
          await page.emulateMedia({ reducedMotion: 'reduce' })
          await page.waitForTimeout(400)
          const stopped = await ring.evaluate(element => getComputedStyle(element).transform)
          await page.waitForTimeout(400)
          assert.equal(await ring.evaluate(element => getComputedStyle(element).transform), stopped)
          result.motion = { press: true, toast: true, pulse: true, reducedMotion: true }
          await page.screenshot({ path: `${directory}/${engine}-motion.png` })
        }
        assert.deepEqual(result.errors, [])
        result.passed = true
      } catch (error) { result.failure = String(error) }
      finally { await context.close(); await writeFile(`${directory}/results.json`, JSON.stringify(results, null, 2)); console.log(engine, build, result.failure ?? 'passed') }
    }
  }
} finally { await new Promise(resolve => server.close(resolve)) }
assert(results.every(result => result.passed), JSON.stringify(results))
