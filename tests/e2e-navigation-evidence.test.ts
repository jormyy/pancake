import { expect, it } from 'vitest'
import { navigationEvidenceFailures } from './e2e/navigation-evidence.mjs'

const account = (role: string) => ({ role, errors: [], blockedRemoteRequests: [], routes: [{ name: 'home', status: 'PASS' }], journeys: [{ name: 'League', status: 'PASS', taps: 1 }] })
const report = () => ({ accounts: [account('commissioner'), account('manager')] })
const validate = (value: ReturnType<typeof report>) => navigationEvidenceFailures(value, ['home'], ['commissioner', 'manager'])

it('accepts both complete local walkthroughs', () => {
    expect(validate(report())).toEqual([])
})

it('rejects missing roles, missing screens, and routes without entry checks', () => {
    expect(validate({ accounts: [] })).toHaveLength(2)
    const missing = report()
    missing.accounts[1].routes = []
    missing.accounts[1].journeys = []
    expect(validate(missing)).toEqual(['manager: missing home', 'manager: no entry points exercised'])
})

it('rejects failed routes and entry points beyond the tap budget', () => {
    const invalid = report()
    invalid.accounts[0].routes[0].status = 'FAIL'
    invalid.accounts[0].journeys[0].status = 'FAIL'
    invalid.accounts[0].journeys[0].taps = 5
    expect(validate(invalid)).toHaveLength(3)
})

it('rejects browser failures and requests outside the local services', () => {
    const invalid = report()
    const first = invalid.accounts[0] as unknown as { errors: string[]; blockedRemoteRequests: string[] }
    first.errors.push('Render failed')
    first.blockedRemoteRequests.push('https://example.invalid')
    expect(validate(invalid)).toHaveLength(2)
})

it('keeps daily actions within three taps', () => {
    const invalid = report()
    invalid.accounts[0].journeys = [{ name: 'Lineup', status: 'PASS', taps: 4, daily: true } as typeof invalid.accounts[0]['journeys'][number]]
    expect(validate(invalid)).toContain('commissioner: too many taps for Lineup')
})
