import { expect, it } from 'vitest'
import * as healthContract from './e2e/configured-source-health-contract.mjs'

it('keeps an absent injury function safe while reporting its recorded failures', () => {
  const evaluate = Reflect.get(healthContract, 'injurySyncHealth')
  expect(evaluate).toBeTypeOf('function')
  expect(evaluate(undefined)).toMatchObject({ status: 'expected-unavailable' })
  expect(evaluate({ status: 'success', rows_affected: 12 })).toMatchObject({ status: 'pass' })
  expect(evaluate({ status: 'failed', error: 'provider timeout' })).toMatchObject({ status: 'fail' })
})
