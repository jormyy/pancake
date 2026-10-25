import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { expect, it } from 'vitest'

const yaml = createRequire(import.meta.url)('js-yaml')
const readiness = yaml.load(readFileSync('.github/workflows/production-readiness.yml', 'utf8'))
const deploy = yaml.load(readFileSync('.github/workflows/production-deploy.yml', 'utf8'))
const ci = yaml.load(readFileSync('.github/workflows/test.yml', 'utf8'))
const steps = readiness.jobs['verify-production'].steps
const conditions = ['Rebuild intended frontend release', 'Rebuild intended Edge artifact provenance'].map(name => steps.find((step: { name: string }) => step.name === name).if)
const evaluate = (condition: string, inputs: object, eventName = 'workflow_dispatch') => Boolean(vm.runInNewContext(condition.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), { inputs, github: { event_name: eventName } }))

it('uses call inputs instead of the caller event to select rebuilds', () => {
  expect(readiness.on.workflow_dispatch.inputs.database_phase).toBeUndefined()
  for (const condition of conditions) expect(condition).not.toContain('github.event_name')
})

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

it('runs the season and benchmark guard tests after installing Deno', () => {
  const steps = ci.jobs['test-edge'].steps
  const deno = steps.findIndex((step: any) => step.uses?.startsWith('denoland/setup-deno@'))
  for (const command of [
    'node --test scripts/season-sim/*.test.mjs',
    'deno test --no-lock --node-modules-dir=none scripts/bench/profile.test.ts scripts/bench/oracle.test.ts',
  ]) {
    expect(steps.findIndex((step: any) => step.run?.includes(command))).toBeGreaterThan(deno)
  }
})
