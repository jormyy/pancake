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

export const ARCHIVE_LEAGUE_DESCRIPTION =
    'Archives the league, cancels active drafts, and hides it from normal navigation. League history and global player data are retained.'

const canAdvanceSeason = (status: LeagueStatus) => status === 'playoffs' || status === 'archived'

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
                    label: 'Schedule Controls',
                    detail: 'Build or reset the schedule when the next season is ready for matchups.',
                    actions: groups.scheduleActions,
                }
            case 'archived':
                return {
                    label: 'Annual Cycle',
                    detail: 'Create the next season from the archived league year.',
                    actions: groups.annualCycleActions,
                }
            case 'setup':
            case 'drafting':
            case 'active':
                return {
                    label: 'Schedule Controls',
                    detail: 'Build or reset the regular-season schedule before managers rely on matchups.',
                    actions: groups.scheduleActions,
                }
        }
    })()

    const lowerPriorityActions = [...groups.utilityActions]
    if (status !== 'playoffs') lowerPriorityActions.push(...groups.playoffActions)
    if (canAdvanceSeason(status) && status !== 'archived') lowerPriorityActions.push(...groups.annualCycleActions)
    if (status === 'playoffs' || status === 'archived') lowerPriorityActions.push(...groups.scheduleActions)

    return { lifecycle, lowerPriorityActions }
}

export function tradeVetoDescription(mode: TradeVetoMode): string {
    if (mode === 'disabled') return 'Accepted trades complete immediately with no veto period.'
    if (mode === 'commissioner') return 'Accepted trades wait through the window; only commissioners can veto.'
    return 'Accepted trades wait through the window; non-party member votes can veto at the configured threshold.'
}
