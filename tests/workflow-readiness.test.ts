import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { expect, it } from 'vitest'

const yaml = createRequire(import.meta.url)('js-yaml')
const readiness = yaml.load(readFileSync('.github/workflows/production-readiness.yml', 'utf8'))
const deploy = yaml.load(readFileSync('.github/workflows/production-deploy.yml', 'utf8'))
const steps = readiness.jobs['verify-production'].steps
const conditions = ['Rebuild intended frontend release', 'Rebuild intended Edge artifact provenance'].map(name => steps.find((step: { name: string }) => step.name === name).if)
const evaluate = (condition: string, inputs: object, eventName = 'workflow_dispatch') => Boolean(vm.runInNewContext(condition.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), { inputs, github: { event_name: eventName } }))

it.each([
  ['verify-candidate-current-backend', true, false],
  ['verify-current-after-migration', false, false],
  ['verify-current-new-edge', false, true],
  ['verify-candidate-new-edge', true, true],
  ['verify-production', true, true],
  ['verify-post-promotion-rollback', false, false],
])('evaluates the deployed artifact rebuilds for %s', (name, frontend, edge) => {
  const call = deploy.jobs[name]
  expect(call?.uses).toBe('./.github/workflows/production-readiness.yml')
  for (const event of ['workflow_dispatch', 'push', 'pull_request']) {
    expect(conditions.map(condition => evaluate(condition, call.with, event))).toEqual([frontend, edge])
  }
})

it.each(['workflow_dispatch', 'repository_dispatch'])('rebuilds both artifacts for a direct %s run', event => {
  expect(conditions.map(condition => evaluate(condition, {}, event))).toEqual([true, true])
})

it('supplies database CI with its checkout-scoped private target', () => {
  const workflow = yaml.load(readFileSync('.github/workflows/test.yml', 'utf8'))
  const config = readFileSync('supabase/config.toml', 'utf8')
  const port = (section: string) => config.match(new RegExp(`^\\[${section}\\]\\n(?:(?!\\[)[^\\n]*\\n)*?port\\s*=\\s*(\\d+)\\s*$`, 'm'))?.[1]
  expect(workflow.jobs['test-database'].env).toMatchObject({
    PANCAKE_TEST_DB_PORT: port('db'),
    PANCAKE_TEST_API_PORT: port('api'),
    PANCAKE_TEST_PROJECT_ID: config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1],
  })
})
