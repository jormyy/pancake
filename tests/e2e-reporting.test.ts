import { describe, expect, it } from 'vitest'
import { productionCoverageStatus } from './e2e/harness/reporting.mjs'

describe('productionCoverageStatus', () => {
    it('ignores documentation evidence while requiring every operational row', () => {
        expect(productionCoverageStatus([])).toBe('PENDING')
        expect(productionCoverageStatus([
            { requirement: 'Phase A audit report', status: 'PENDING' },
            { requirement: 'P0/P1 findings resolved', status: 'PARTIAL' },
            { requirement: 'Database replay', status: 'PASS' },
            { requirement: 'Browser gameplay', status: 'PASS' },
        ])).toBe('PASS')
        expect(productionCoverageStatus([
            { requirement: 'Database replay', status: 'PASS' },
            { requirement: 'Browser gameplay', status: 'PENDING' },
        ])).toBe('PENDING')
        expect(productionCoverageStatus([
            { requirement: 'Database replay', status: 'BLOCKED' },
        ])).toBe('FAIL')
    })
})
