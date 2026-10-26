import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/e2e/performance-budgets.json'), 'utf8'))

describe('instant-loading performance budget contract', () => {
    it('ranks exactly 10 workflows with budgets matching the instant-loading goal', () => {
        expect(manifest.version).toBe(1)
        expect(manifest.workflows).toHaveLength(10)
        expect(manifest.globalBudgets.minHeartbeatSamples).toBe(10)

        const ranks = manifest.workflows.map((workflow: any) => workflow.rank).sort((a: number, b: number) => a - b)
        expect(ranks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

        const ids = new Set<string>()
        for (const workflow of manifest.workflows) {
            expect(workflow.id).toMatch(/^[a-z0-9-]+$/)
            expect(ids.has(workflow.id)).toBe(false)
            ids.add(workflow.id)

            expect(workflow.name).toEqual(expect.any(String))
            expect(workflow.name.trim()).not.toHaveLength(0)
            expect(workflow.frequency).toEqual(expect.any(String))
            expect(workflow.frequency.trim()).not.toHaveLength(0)
            expect(workflow.pain).toEqual(expect.any(String))
            expect(workflow.pain.trim()).not.toHaveLength(0)
            expect(workflow.criticalPath.length).toBeGreaterThanOrEqual(3)
            expect(workflow.measurement.primary).toMatch(/^npm run |^E2E_/)
            expect(workflow.measurement.report).toMatch(/^tests\//)

            expect(workflow.budgets.feedbackMs).toBeLessThanOrEqual(manifest.globalBudgets.instantFeedbackMs)
            expect(workflow.budgets.cachedRequestMs).toBeLessThanOrEqual(manifest.globalBudgets.cachedRequestMs)
            expect(workflow.budgets.fullLoadMs).toBeLessThanOrEqual(manifest.globalBudgets.fullWorkflowMs)
        }
    })
})
