import type { TradeVetoMode } from '@/lib/league'
import type { LeagueStatus } from '@/types/database'
export type { LeagueStatus } from '@/types/database'

export type CommissionerActionId =
    | 'generate-playoffs'
    | 'advance-playoffs'
    | 'process-waivers'
    | 'sync-stats'
    | 'sync-scores'
    | 'sync-rankings'
    | 'sync-projections'
    | 'sync-games'
    | 'generate-schedule'
    | 'reset-schedule'
    | 'advance-season'
    | 'delete-league'

export type CommissionerAction = {
    id: CommissionerActionId
    label: string
    onPress: () => void | Promise<void>
    intent?: 'primary' | 'danger'
    description?: string
}

type ActionGroups = {
    playoffActions: CommissionerAction[]
    annualCycleActions: CommissionerAction[]
    scheduleActions: CommissionerAction[]
    utilityActions: CommissionerAction[]
}

export function commissionerLifecyclePolicy(status: LeagueStatus, groups: ActionGroups) {
    const lifecycle = (() => {
        switch (status) {
            case 'playoffs':
                return {
                    label: 'Playoff Controls',
                    detail: 'Generate the bracket or advance after each playoff round is finalized.',
                    actions: groups.playoffActions,
                }
            case 'offseason':
                return {
                    label: 'Annual Cycle',
                    detail: 'Create the next season when rosters and results are ready to roll forward.',
                    actions: groups.annualCycleActions,
                }
            case 'setup':
            case 'drafting':
            case 'active':
            case 'archived':
                return {
                    label: 'Schedule Controls',
                    detail: 'Build or reset the regular-season schedule before managers rely on matchups.',
                    actions: groups.scheduleActions,
                }
        }
    })()

    const lowerPriorityActions = [...groups.utilityActions]
    if (status !== 'playoffs') lowerPriorityActions.push(...groups.playoffActions)
    if (status !== 'offseason') lowerPriorityActions.push(...groups.annualCycleActions)
    if (status === 'playoffs' || status === 'offseason') lowerPriorityActions.push(...groups.scheduleActions)

    return { lifecycle, lowerPriorityActions }
}

export function tradeVetoDescription(mode: TradeVetoMode): string {
    if (mode === 'disabled') return 'Accepted trades complete immediately with no veto period.'
    if (mode === 'commissioner') return 'Accepted trades wait through the window; only commissioners can veto.'
    return 'Accepted trades wait through the window; non-party member votes can veto at the configured threshold.'
}
