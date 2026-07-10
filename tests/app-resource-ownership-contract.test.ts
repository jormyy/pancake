import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')

describe('route resource ownership contracts', () => {
    it('gates lineup data and row actions by the current member and league', () => {
        const lineup = source('app/(modals)/lineup.tsx')
        expect(lineup).toContain('const ownsLineup = dataOwnerKey === ownerKey')
        expect(lineup).toContain('const visibleCtx = ownsLineup ? ctx : null')
        expect(lineup).toContain('disabled={saving || lineupRefreshing || lineupLoading}')
    })

    it('keys player roster status and destructive action state to the route owner', () => {
        const player = source('app/player/[id].tsx')
        expect(player).toContain('rosterStatusResource.ownerIdentity === ownerIdentity')
        expect(player).toContain('if (!isCurrent(generation, requestedOwner)) return')
        expect(player).toContain('visible={ownsActionState && dropPickerVisible}')
        expect(player).toContain("function continueAfterIR(action: 'add' | 'claim')")
        expect(player).not.toContain('tryAddFreeAgent/push/id are stable enough')
    })

    it('preserves waiver form state across same-owner membership refreshes', () => {
        const claim = source('app/(modals)/claim-player.tsx')
        expect(claim).toContain('const memberId = current?.id')
        expect(claim).toContain('const userId = user?.id')
        expect(claim).toContain('}, [leagueId, memberId, playerId, userId])')
        expect(claim).not.toContain('[playerId, current, user, leagueId]')
    })

    it('keys playoff bracket data to the selected member and league', () => {
        const bracket = source('app/(modals)/bracket.tsx')
        expect(bracket).toContain('resource.key === resourceKey ? resource.bracket : null')
        expect(bracket).toContain('if (requestRef.current === requestId)')
    })
})
