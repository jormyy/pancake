import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFile(path, 'utf8')

// Source contracts for states that only show up in a browser: an error must
// never render as an empty result, empty lists must say so, and the PWA must
// keep looking for updates while it stays in the foreground.

describe('home matchup surface wiring', () => {
    it('drives the play surface from resolveHomeSurface so the tested precedence is what renders', async () => {
        const source = await read('app/(tabs)/index.tsx')
        expect(source).toContain("resolveHomeSurface({ leagueStatus: league?.status, hasMatchup: Boolean(matchup), loading: matchupLoading, error })")
        for (const surface of ['draft', 'loading', 'error']) expect(source).toContain(`homeSurface === '${surface}'`)
        expect(source.indexOf("homeSurface === 'error'")).toBeLessThan(source.indexOf('message="No matchup this week yet"'))
    })
})

describe('trades tab empty states', () => {
    // The read model emits its own empty rows per section, so the screen must
    // not add a parallel empty branch (review S3: listData always has a header).
    it('lets the read model own the empty rows and adds no screen-level fallback', async () => {
        const source = await read('app/(tabs)/trades.tsx')
        expect(source).not.toContain('TRADE_TAB_EMPTY_TEXT')
        expect(source).not.toMatch(/listData\.length === 0/)
    })
})

describe('service worker registration cadence', () => {
    it('re-checks for a new release on reconnect and hourly while visible, and waits 10s for the worker version', async () => {
        const source = await read('app/+html.tsx')
        expect(source).toContain("window.addEventListener('online', checkForUpdate)")
        expect(source).toMatch(/setInterval\(function \(\) \{\s*if \(document\.visibilityState === 'visible'\) checkForUpdate\(\);\s*\}, 60 \* 60 \* 1000\)/)
        expect(source).toContain('setTimeout(function () { finish(null); }, 10000)')
        expect(source).not.toContain('finish(null); }, 2000)')
    })
})

describe('edge job bookkeeping', () => {
    it('season-boundary records per-league failures on the sync run', async () => {
        const source = await read('supabase/functions/season-boundary/index.ts')
        expect(source).toContain('failure: summarizeBoundaryFailures(reports)')
    })

    it('process-waivers notifies each committed batch instead of buffering the whole drain', async () => {
        const source = await read('supabase/functions/process-waivers/index.ts')
        const loop = source.slice(source.indexOf('for (let batch = 0'), source.indexOf("expire_waiver_wire_logs"))
        expect(loop).toContain('await notifyClaimResults(batchRows)')
        expect(source).not.toContain('notifyClaimResults(rows)')
    })

    it('the backfill progress poll projects columns instead of select(*)', async () => {
        const source = await read('supabase/functions/api/sync.ts')
        expect(source).not.toContain("select('*')")
    })
})
