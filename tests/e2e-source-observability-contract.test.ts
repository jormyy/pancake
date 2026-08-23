import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) => readFileSync(path, 'utf8')

describe('configured source observability', () => {
    it('fails the player sync when ESPN news fails', () => {
        const source = readSource('supabase/functions/sync-players/index.ts')

        expect(source).toContain('...news.failures')
    })

    it('records every draft-order attempt', () => {
        const source = readSource('supabase/functions/sync-draft-order/index.ts')

        expect(source).toContain("recordSyncRun('sync-draft-order'")
    })

    it('records NBA scoreboard failures before using stored active games', () => {
        const source = readSource('supabase/functions/live-poll/index.ts')

        expect(source).toContain("recordSyncRun('source:nba-cdn-scoreboard'")
    })
})
