import { describe, expect, it } from 'vitest'
import {
    CONFIGURED_GAME_SOURCES,
    evaluateConfiguredSourceHealth,
} from './e2e/configured-source-health-contract.mjs'

const dimension = (status = 'pass') => ({ status, evidence: 'verified evidence' })
const completeReport = () => CONFIGURED_GAME_SOURCES.map((source) => ({
    id: source.id,
    ...(source.disabled ? { disabledReason: 'Dormant fallback.' } : {}),
    freshness: dimension(source.disabled ? 'disabled' : 'pass'),
    completeness: dimension(source.disabled ? 'disabled' : 'pass'),
    failures: dimension(source.disabled ? 'disabled' : 'pass'),
    recovery: dimension(source.disabled ? 'disabled' : 'pass'),
}))

describe('configured source health contract', () => {
    it('requires every configured source and all four health dimensions', () => {
        const report = completeReport().slice(1)

        expect(evaluateConfiguredSourceHealth(report)).toMatchObject({
            pass: false,
            failures: expect.arrayContaining(['missing source: nba-cdn']),
        })
    })

    it('blocks a reported source failure', () => {
        const report = completeReport()
        report[0].failures = dimension('fail')

        expect(evaluateConfiguredSourceHealth(report)).toMatchObject({
            pass: false,
            failures: expect.arrayContaining(['nba-cdn: failures is fail']),
        })
    })

    it('accepts a complete healthy report and an explained disabled fallback', () => {
        expect(evaluateConfiguredSourceHealth(completeReport())).toEqual({ pass: true, failures: [] })
    })
})

