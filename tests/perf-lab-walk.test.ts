import { expect, it } from 'vitest'
import { inventory } from '../scripts/perf-lab/workloads.mjs'
import { expectedSurface } from '../scripts/perf-lab/surfaces.mjs'

it('checks Schedule through the integrated WebKit screen walk', async () => {
    const work = await inventory()
    const surface = work.surfaces.find((row: { id: string }) => row.id === 'league-dashboard.schedule')
    expect(surface?.route).toBe('/league?tab=schedule')
    expect(work.rows.filter((row: { surface: string }) => row.surface === surface?.id)).toHaveLength(24)
    expect(expectedSurface(surface, {}, 'commissioner')).toEqual({ all: [
        { selector: '#league-tab-schedule[aria-selected="true"]' },
        { selector: '#league-panel-schedule [aria-label="Your season schedule"] [role="listitem"]' },
    ] })
})
