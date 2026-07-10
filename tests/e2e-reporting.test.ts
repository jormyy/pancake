import { describe, expect, it } from 'vitest'
import { evidenceStatusForRows, productionCoverageStatus } from './e2e/harness/reporting.mjs'

describe('productionCoverageStatus', () => {
    it('ignores documentation evidence while requiring every operational row', () => {
        expect(productionCoverageStatus([])).toBe('PENDING')
        expect(productionCoverageStatus([
            { id: 'docs', status: 'PENDING', requiredForRelease: false },
            { id: 'database', status: 'PASS', requiredForRelease: true },
            { id: 'browser', status: 'PASS', requiredForRelease: true },
        ])).toBe('PASS')
        expect(productionCoverageStatus([
            { id: 'database', status: 'PASS', requiredForRelease: true },
            { id: 'browser', status: 'PENDING', requiredForRelease: true },
        ])).toBe('PENDING')
        expect(productionCoverageStatus([
            { id: 'database', status: 'BLOCKED', requiredForRelease: true },
        ])).toBe('FAIL')
    })
})

describe('evidenceStatusForRows', () => {
    it('does not turn an enabled switch into passing evidence', () => {
        expect(evidenceStatusForRows([], false, true, 'browser.auth')).toBe('PENDING')
        expect(evidenceStatusForRows([], true, true, 'browser.auth')).toBe('FAIL')
        expect(evidenceStatusForRows([
            { season: 1, status: 'PASS', notes: '', evidenceIds: ['browser.auth'] },
        ], false, true, 'browser.auth')).toBe('PASS')
    })
})
