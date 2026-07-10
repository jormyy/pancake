import { useCallback, useMemo, useRef, useState } from 'react'
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
    ownerId,
    league,
    refresh,
    onDeleted,
}: {
    ownerId: string | null
    league: LeagueInfo | null
    refresh: () => Promise<void>
    onDeleted: () => void
}) {
    const ownerKey = ownerId && league ? `${ownerId}:${league.id}` : null
    const activeOwnerKeyRef = useRef(ownerKey)
    activeOwnerKeyRef.current = ownerKey
    const mutationSequenceRef = useRef(0)
    const activeMutationRef = useRef<{ ownerKey: string; token: number } | null>(null)
    const [busy, setBusy] = useState<{
        ownerKey: string
        action: CommissionerActionId
        token: number
    } | null>(null)

    const beginMutation = useCallback((capturedOwnerKey: string, action: CommissionerActionId) => {
        if (activeOwnerKeyRef.current !== capturedOwnerKey) return null
        if (activeMutationRef.current?.ownerKey === capturedOwnerKey) return null
        const mutation = { ownerKey: capturedOwnerKey, token: ++mutationSequenceRef.current }
        activeMutationRef.current = mutation
        setBusy({ ...mutation, action })
        return mutation
    }, [])

    const ownsMutation = useCallback((mutation: { ownerKey: string; token: number }) => (
        activeOwnerKeyRef.current === mutation.ownerKey
        && activeMutationRef.current?.token === mutation.token
    ), [])

    const finishMutation = useCallback((mutation: { ownerKey: string; token: number }) => {
        if (activeMutationRef.current?.token !== mutation.token) return
        activeMutationRef.current = null
        setBusy((current) => current?.token === mutation.token ? null : current)
    }, [])

    const runAdmin = useCallback(async (
        path: string,
        message: string,
        action: CommissionerActionId,
        body: Record<string, unknown> = {},
    ) => {
        if (!ownerKey) return
        const mutation = beginMutation(ownerKey, action)
        if (!mutation) return
        try {
            await apiPost(path, body)
            if (ownsMutation(mutation)) showSuccess('Done', message)
        } catch (error) {
            if (ownsMutation(mutation)) showAlert('Error', getErrorMessage(error))
        } finally {
            finishMutation(mutation)
        }
    }, [beginMutation, finishMutation, ownerKey, ownsMutation])

    const actions = useMemo(() => {
        const generateSchedule = (force: boolean) => league ? runAdmin(
            '/sync/matchups',
            force ? 'Schedule reset and regenerated.' : 'Schedule generated successfully.',
            force ? 'reset-schedule' : 'generate-schedule',
            { force, leagueId: league.id },
        ) : undefined
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
                    if (!ownerKey) return
                    const mutation = beginMutation(ownerKey, 'advance-season')
                    if (!mutation) return
                    try {
                        await advanceSeason(league.id)
                        if (!ownsMutation(mutation)) return
                        await refresh()
                        if (ownsMutation(mutation)) {
                            showSuccess('Done', 'Season advanced. Start the rookie draft when ready.')
                        }
                    } catch (error) {
                        if (ownsMutation(mutation)) showAlert('Error', getErrorMessage(error))
                    } finally {
                        finishMutation(mutation)
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
    }, [beginMutation, finishMutation, league, ownerKey, ownsMutation, refresh, runAdmin])

    const handleDeleteLeague = () => {
        if (!league) return
        confirmAction(
            'Archive League',
            `${ARCHIVE_LEAGUE_DESCRIPTION} Archive ${league.name}?`,
            async () => {
                if (!ownerKey) return
                const mutation = beginMutation(ownerKey, 'delete-league')
                if (!mutation) return
                try {
                    await deleteLeague(league.id)
                    if (!ownsMutation(mutation)) return
                    await refresh()
                    if (ownsMutation(mutation)) {
                        showSuccess('League archived', 'The league has been archived and hidden from your league list.')
                        onDeleted()
                    }
                } catch (error) {
                    if (ownsMutation(mutation)) showAlert('Error', getErrorMessage(error))
                } finally {
                    finishMutation(mutation)
                }
            },
            'Archive League',
            true,
        )
    }

    const busyAction = busy?.ownerKey === ownerKey ? busy.action : null
    return { ...actions, busyAction, handleDeleteLeague }
}
