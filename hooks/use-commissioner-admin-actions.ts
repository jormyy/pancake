import { useMemo, useState } from 'react'
import type { LeagueInfo } from '@/types/app'
import { apiPost } from '@/lib/shared/api'
import { advanceSeason } from '@/lib/rookieDraft'
import { deleteLeague } from '@/lib/league'
import { confirmAction, getErrorMessage, showAlert, showSuccess } from '@/lib/alert'
import {
    ARCHIVE_LEAGUE_DESCRIPTION,
    commissionerLifecyclePolicy,
    type CommissionerAction,
    type CommissionerActionId,
} from '@/lib/commissioner-settings-policy'

export function useCommissionerAdminActions({
    league,
    refresh,
    onDeleted,
}: {
    league: LeagueInfo | null
    refresh: () => Promise<void>
    onDeleted: () => void
}) {
    const [busyAction, setBusyAction] = useState<CommissionerActionId | null>(null)
    const runAdmin = async (
        path: string,
        message: string,
        action: CommissionerActionId,
        body: Record<string, unknown> = {},
    ) => {
        setBusyAction(action)
        try {
            await apiPost(path, body)
            showSuccess('Done', message)
        } catch (error) {
            showAlert('Error', getErrorMessage(error))
        } finally {
            setBusyAction(null)
        }
    }

    const actions = useMemo(() => {
        const generateSchedule = (force: boolean) => runAdmin(
            '/sync/matchups',
            force ? 'Schedule reset and regenerated.' : 'Schedule generated successfully.',
            force ? 'reset-schedule' : 'generate-schedule',
            { force },
        )
        const scheduleActions: CommissionerAction[] = [
            { id: 'generate-schedule', label: 'Generate Season Schedule', onPress: () => generateSchedule(false) },
            {
                id: 'reset-schedule',
                label: 'Reset & Regenerate Schedule',
                intent: 'danger',
                description: 'Deletes every existing matchup and rebuilds the season schedule from scratch.',
                onPress: () => confirmAction(
                    'Reset Schedule',
                    'This will delete all existing matchups and regenerate. Are you sure?',
                    () => generateSchedule(true),
                    'Reset',
                    true,
                ),
            },
        ]
        const playoffActions: CommissionerAction[] = [
            {
                id: 'generate-playoffs', label: 'Generate Playoff Bracket',
                onPress: () => league ? runAdmin('/playoffs/generate', 'Semifinal bracket generated.', 'generate-playoffs', { leagueId: league.id }) : undefined,
            },
            {
                id: 'advance-playoffs', label: 'Advance to Championship',
                onPress: () => league ? runAdmin('/playoffs/advance', 'Championship matchup created.', 'advance-playoffs', { leagueId: league.id }) : undefined,
                description: 'Finalizes the semifinal results and creates the championship matchup. Semifinal scores cannot change after this.',
            },
        ]
        const annualCycleActions: CommissionerAction[] = [{
            id: 'advance-season',
            label: 'Advance to Next Season',
            intent: 'primary',
            description: 'Closes the current season and rolls all teams into the next league year. The finished season becomes read-only history.',
            onPress: () => league ? confirmAction(
                'Advance Season',
                'This will create a new season, carry rosters forward, and set the league to offseason. Continue?',
                async () => {
                    setBusyAction('advance-season')
                    try {
                        await advanceSeason(league.id)
                        await refresh()
                        showSuccess('Done', 'Season advanced. Start the rookie draft when ready.')
                    } catch (error) {
                        showAlert('Error', getErrorMessage(error))
                    } finally {
                        setBusyAction(null)
                    }
                },
                'Advance',
                true,
            ) : undefined,
        }]
        const utilityActions: CommissionerAction[] = [
            { id: 'process-waivers', label: 'Process Waiver Claims', onPress: () => runAdmin('/waivers/process', 'Waiver claims processed.', 'process-waivers') },
            { id: 'sync-stats', label: 'Sync Player Stats', onPress: () => runAdmin('/sync/stats', 'Stats synced (last 7 days).', 'sync-stats', { days: 7 }) },
            { id: 'sync-scores', label: 'Sync Scores Now', onPress: () => runAdmin('/sync/scores', 'Scores synced.', 'sync-scores') },
            { id: 'sync-rankings', label: 'Sync Dynasty Rankings', onPress: () => runAdmin('/sync/rankings', 'Dynasty rankings synced.', 'sync-rankings') },
            { id: 'sync-projections', label: 'Sync Projections', onPress: () => runAdmin('/sync/projections', 'Projections synced.', 'sync-projections') },
            { id: 'sync-games', label: 'Sync NBA Game Schedule', onPress: () => runAdmin('/sync/schedule', 'Game schedule synced.', 'sync-games') },
        ]
        return commissionerLifecyclePolicy(league?.status ?? 'setup', {
            playoffActions,
            annualCycleActions,
            scheduleActions,
            utilityActions,
        })
    }, [league, refresh])

    const handleDeleteLeague = () => {
        if (!league) return
        confirmAction(
            'Archive League',
            `${ARCHIVE_LEAGUE_DESCRIPTION} Archive ${league.name}?`,
            async () => {
                setBusyAction('delete-league')
                try {
                    await deleteLeague(league.id)
                    await refresh()
                    showSuccess('League archived', 'The league has been archived and hidden from your league list.')
                    onDeleted()
                } catch (error) {
                    showAlert('Error', getErrorMessage(error))
                } finally {
                    setBusyAction(null)
                }
            },
            'Archive League',
            true,
        )
    }

    return { ...actions, busyAction, handleDeleteLeague }
}
