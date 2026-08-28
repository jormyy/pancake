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

    it('cancels roster confirmations and action effects when membership changes', () => {
        const roster = source('app/(tabs)/roster.tsx')
        expect(roster).toContain("const ownerIdentity = current?.id && leagueId ? `${current.id}:${leagueId}` : null")
        expect(roster).toContain('actionGenerationRef.current += 1')
        expect(roster.match(/if \(!isCurrentAction\(generation, identity\)\) return/g)?.length).toBeGreaterThanOrEqual(5)
        expect(roster).toContain('rosterRecoveryRunnerRef.current = createRosterRecoveryRunner()')
    })

    it('keys player roster status and destructive action state to the route owner', () => {
        const player = source('app/player/[id].tsx')
        expect(player).toContain('rosterStatusResource.ownerIdentity === ownerIdentity')
        expect(player).toContain('if (!isCurrent(generation, requestedOwner)) return')
        // The pickup flow lives in useQuickAdd, keyed to member + league; the page only feeds it and reads its state.
        expect(player).toContain('onChanged: loadRosterStatus,')
        expect(player).toContain('visible={quickAdd.dropPickerPlayer !== null}')
        expect(player).not.toContain('loadRosterAddGate')
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
