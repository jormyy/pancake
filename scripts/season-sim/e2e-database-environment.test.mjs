import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

for (const file of ['exact-controls.mjs', 'form-submission-update.mjs']) {
  test(`${file} removes inherited services and keeps its local SQL success and failure checks`, () => {
    const replacements = {
      playwright: 'export const chromium = {}; export const webkit = {}',
      '@supabase/supabase-js': 'export const createClient = () => {}',
      'node:child_process': `
        import assert from 'node:assert/strict'
        export const spawn = () => { throw new Error('Unexpected service launch') }
        export const spawnSync = (command, args, options) => {
          assert.equal(command, 'psql')
          assert.equal(options.env.PGHOST, '127.0.0.1')
          assert.equal(options.env.PGHOSTADDR, '127.0.0.1')
          assert.equal(options.env.PGPORT, '57122')
          assert.equal(options.env.PGDATABASE, 'postgres')
          assert.equal(options.env.PGUSER, 'fixture')
          assert.equal(options.env.PGPASSWORD, 'fixture')
          assert.equal(Object.hasOwn(options.env, 'PGSERVICE'), false)
          assert.equal(Object.hasOwn(options.env, 'PGSERVICEFILE'), false)
          assert.equal(options.env.E2E_ENVIRONMENT_SENTINEL, 'retained')
          assert.deepEqual(args.slice(0, 4), ['-XAt', '-v', 'ON_ERROR_STOP=1', '-c'])
          if (args[4] === 'select 42') return { status: 0, stdout: '42\\n', stderr: '' }
          assert.equal(args[4], 'select 1/0')
          return { status: 1, stdout: '', stderr: 'division by zero' }
        }
      `,
    }
    const program = `
      import { registerHooks } from 'node:module'
      const replacements = ${JSON.stringify(replacements)}
      registerHooks({ resolve(specifier, context, next) {
        return replacements[specifier]
          ? { url: 'data:text/javascript,' + encodeURIComponent(replacements[specifier]), shortCircuit: true }
          : next(specifier, context)
      } })
      process.argv.push('--check-sql-errors')
      await import(${JSON.stringify(new URL(`../../tests/e2e/${file}`, import.meta.url).href)})
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      encoding: 'utf8',
      env: {
        ...process.env,
        EXACT_CONTROLS_PLAYWRIGHT: 'playwright',
        FORM_SUBMISSIONS_PLAYWRIGHT: 'playwright',
        FORM_SUBMISSIONS_ENGINE: 'chromium',
        FORM_LEGACY_CONFIRMATION: '0',
        E2E_SUPABASE_URL: 'http://127.0.0.1:57121',
        SUPABASE_DB_URL: 'postgresql://fixture:fixture@127.0.0.1:57122/postgres',
        PGHOST: '198.51.100.1',
        PGHOSTADDR: '198.51.100.2',
        PGSERVICE: 'wrong-service',
        PGSERVICEFILE: '/missing-service',
        E2E_ENVIRONMENT_SENTINEL: 'retained',
      },
    })
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /Local SQL success and failure checks pass without connection details/)
  })
}
