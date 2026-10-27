import { describe, expect, it } from 'vitest'
import { REQUIRED_FULL_SWEEP_LABELS, timelineSurfaceFailures } from '../../e2e/browser-smoke.mjs'

describe('timeline browser smoke contract', () => {
    it('requires the real timeline route and its filters', () => {
        expect(REQUIRED_FULL_SWEEP_LABELS).toContain('timeline')
        expect(timelineSurfaceFailures({ text: 'Timeline Your team activity', buttons: ['All', 'Claims', 'Trades', 'Lineups', 'Scores'] })).toEqual([])
    })
    it('rejects missing filters and failed timeline reads', () => {
        expect(timelineSurfaceFailures({ text: 'Timeline Could not load the timeline', buttons: ['All'] })).toContain('Timeline filter is missing: Claims')
        expect(timelineSurfaceFailures({ text: 'Timeline Could not load the timeline', buttons: ['All'] })).toContain('Timeline failed to load')
        expect(timelineSurfaceFailures()).toContain('Timeline heading is missing')
    })
})
