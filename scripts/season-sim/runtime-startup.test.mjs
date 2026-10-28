import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('fresh runtime passes its database URL through the clock target guard', () => {
  const runtime = new URL('./runtime.mjs', import.meta.url).href
  const common = new URL('./common.mjs', import.meta.url).href
  const replacements = {
    './common.mjs': `export const config = {}; export const originUrl = () => ''; export const delay = async () => {}; export const laneDirectory = async () => '/fixture'; export const miniRoot = '/fixture'; export const writeJson = async () => {}`,
    './local-stack.mjs': `export const localKeys = () => ({ API_URL: 'http://127.0.0.1:57221', DB_URL: 'postgresql://postgres:fixture@127.0.0.1:57222/postgres' }); export const sql = async () => JSON.stringify(Object.fromEntries(['current_timestamp','current_date','current_time','localtimestamp','localtime','timeofday'].map(key => [key,{objects:[]}])));`,
    './clock.mjs': `import { assertTarget } from ${JSON.stringify(common)}; export const setClock = async () => { assertTarget(process.env.SUPABASE_DB_URL, 'db'); throw new Error('CLOCK_TARGET_PASSED') }`,
    './origin.mjs': `export const startOrigin = () => { throw new Error('Unexpected server launch') }`,
    'node:fs/promises': `export const readFile = async () => ''; export const open = () => { throw new Error('Unexpected file open') }`,
  }
  const program = `
    import assert from 'node:assert/strict'
    import { registerHooks } from 'node:module'
    const replacements = ${JSON.stringify(replacements)}
    registerHooks({ resolve(specifier, context, next) {
      return context.parentURL === ${JSON.stringify(runtime)} && replacements[specifier]
        ? { url: 'data:text/javascript,' + encodeURIComponent(replacements[specifier]), shortCircuit: true }
        : next(specifier, context)
    } })
    const { startRuntime } = await import(${JSON.stringify(runtime)})
    await assert.rejects(() => startRuntime('2025-10-21T00:00:00Z'), /^Error: CLOCK_TARGET_PASSED$/)
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8', env: { ...process.env, SEASON_SIM_PORT_PREFIX: '572', SEASON_SIM_PROJECT: 'pt4basim' },
  })
  assert.equal(child.status, 0, child.stderr)
})
