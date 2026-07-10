import { describe, expect, it, vi } from 'vitest'
import {
    ARCHIVE_LEAGUE_DESCRIPTION,
    commissionerLifecyclePolicy,
    type CommissionerAction,
} from '@/lib/commissioner-settings-policy'
import type { LeagueStatus } from '@/types/database'

const action = (id: CommissionerAction['id']): CommissionerAction => ({ id, label: id, onPress: vi.fn() })
const groups = {
    playoffActions: [action('generate-playoffs')],
    annualCycleActions: [action('advance-season')],
    scheduleActions: [action('generate-schedule')],
    utilityActions: [action('sync-stats')],
}

describe('commissioner lifecycle policy', () => {
    it.each<LeagueStatus>(['setup', 'drafting', 'active', 'offseason'])('hides season advance in %s', (status) => {
        const policy = commissionerLifecyclePolicy(status, groups)
        expect([...policy.lifecycle.actions, ...policy.lowerPriorityActions].map(({ id }) => id))
            .not.toContain('advance-season')
    })

    it.each<LeagueStatus>(['playoffs', 'archived'])('offers season advance in canonical RPC state %s', (status) => {
        const policy = commissionerLifecyclePolicy(status, groups)
        expect([...policy.lifecycle.actions, ...policy.lowerPriorityActions].map(({ id }) => id))
            .toContain('advance-season')
    })

    it('describes the implemented archive behavior without claiming permanent deletion', () => {
        expect(ARCHIVE_LEAGUE_DESCRIPTION).toContain('Archives')
        expect(ARCHIVE_LEAGUE_DESCRIPTION).toContain('retained')
        expect(ARCHIVE_LEAGUE_DESCRIPTION).not.toMatch(/permanent|cannot be undone/i)
    })
})
