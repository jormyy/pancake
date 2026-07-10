import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8')

describe('roster overflow browser contract', () => {
    it('presents direct accessible trim actions and locks lineup entry', () => {
        const rosterScreen = read('app/(tabs)/roster.tsx')
        const trimBanner = read('components/roster/RosterTrimBanner.tsx')

        expect(rosterScreen).toContain('Trim Roster First')
        expect(rosterScreen).toContain('disabled={rosterOverflow > 0}')
        expect(rosterScreen).toContain('<RosterTrimBanner')
        expect(trimBanner).toContain('Trim roster: {excess} over limit')
        expect(trimBanner).toContain('Drop ${player.players.display_name}')
        expect(trimBanner).toContain('Move ${player.players.display_name} to IR')
        expect(trimBanner).toContain('Move ${player.players.display_name} to Taxi Squad')
        expect(trimBanner).toContain('minHeight: 44')
    })
})
