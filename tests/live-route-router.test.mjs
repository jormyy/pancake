import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const config = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'))

function route(pathname) {
  for (const row of config.routes) {
    if (!row.src) continue
    const match = new RegExp(row.src).exec(pathname)
    if (!match) continue
    if (row.dest) return { status: row.status, dest: row.dest.replace(/\$(\d+)/g, (_, index) => match[Number(index)]) }
    if (!row.continue) return {}
  }
  return {}
}

function functionFor(dest) {
  const file = `${new URL(dest, 'http://vercel').pathname.slice(1)}.js`
  assert.ok(config.functions[file], `vercel.json routes /api/live to ${dest}, but functions has no ${file}`)
  assert.ok(existsSync(path.join(root, file)), `${file} is missing; run npm run generate:live-route`)
  return createRequire(import.meta.url)(path.join(root, file)).default
}

async function serve(handler, run) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { return await run(`http://127.0.0.1:${server.address().port}`) }
  finally { await new Promise(resolve => server.close(resolve)) }
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

test('the deployed live route serves /api/live/<date> through vercel.json', async () => {
  process.env.LIVE_SCORES_OFF = '1'
  const requested = `/api/live/${today}`
  const { dest, status } = route(requested)
  assert.ok(dest, `vercel.json has no route for ${requested}`)
  assert.equal(status, undefined)
  const destination = new URL(dest, 'http://vercel')
  const forwarded = [`${requested}${destination.search}`, `${destination.pathname}${destination.search}`]
  await serve(functionFor(dest), async origin => {
    for (const url of forwarded) {
      const response = await fetch(`${origin}${url}`, { redirect: 'manual' })
      assert.equal(response.status, 200, `Vercel forwards ${requested} to the function as ${url}; it answered ${response.status} ${response.headers.get('location') ?? ''}`)
      assert.equal((await response.json()).date, today)
    }
  })
})
