import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { LINEUP_SLOT_TYPES } from '@pancake/core'
import { useLeagueContext } from '@/contexts/league-context'
import {
    adjustFaabBalance,
    deleteLeague,
    getLeagueMembers,
    getLineupSlots,
    overrideWeeklyAddCount,
    updateLeagueConfiguration,
} from '@/lib/league'
import { advanceSeason } from '@/lib/rookieDraft'
import { apiPost } from '@/lib/shared/api'
import { colors } from '@/constants/tokens'
import { confirmAction, getErrorMessage, showAlert, showSuccess } from '@/lib/alert'
import {
    commissionerLifecyclePolicy,
    tradeVetoDescription,
    type CommissionerAction,
    type CommissionerActionId,
} from '@/components/commissioner/settings-policy'
import {
    EMPTY_COMMISSIONER_SETTINGS_DRAFT,
    buildCommissionerSettingsChange,
    tradeVetoModeFromValue,
    waiverModeFromValue,
    type CommissionerSettingsDraft,
} from '@/lib/commissioner-settings-draft'

export const COMMISSIONER_SCORING_FIELDS = [
    { key: 'points', label: 'Points' },
    { key: 'rebounds', label: 'Rebounds' },
    { key: 'assists', label: 'Assists' },
    { key: 'steals', label: 'Steals' },
    { key: 'blocks', label: 'Blocks' },
    { key: 'turnovers', label: 'Turnovers' },
    { key: 'three_pointers_made', label: '3-Pointers Made' },
    { key: 'field_goals_attempted', label: 'Field Goals Attempted' },
    { key: 'field_goals_made', label: 'Field Goals Made' },
    { key: 'free_throws_attempted', label: 'Free Throws Attempted' },
    { key: 'free_throws_made', label: 'Free Throws Made' },
] as const

async function adminCall(
    path: string,
    successMessage: string,
    action: CommissionerActionId,
    setBusyAction: (action: CommissionerActionId | null) => void,
    body: Record<string, unknown> = {},
) {
    setBusyAction(action)
    try {
        await apiPost(path, body)
        showSuccess('Done', successMessage)
    } catch (error) {
        showAlert('Error', getErrorMessage(error))
    } finally {
        setBusyAction(null)
    }
}

export function useCommissionerSettingsController() {
    const { currentLeague: league, isCommissioner, refresh } = useLeagueContext()
    const { back, replace } = useRouter()
    const hydratedLeagueId = useRef<string | null>(null)
    const [draft, setDraft] = useState<CommissionerSettingsDraft>(EMPTY_COMMISSIONER_SETTINGS_DRAFT)
    const [initialDraft, setInitialDraft] = useState<CommissionerSettingsDraft>(EMPTY_COMMISSIONER_SETTINGS_DRAFT)
    const [members, setMembers] = useState<{ id: string; team_name: string | null }[]>([])
    const [overrideMemberId, setOverrideMemberId] = useState<string | null>(null)
    const [overrideFaab, setOverrideFaab] = useState('')
    const [overrideAdds, setOverrideAdds] = useState('')
    const [overrideSaving, setOverrideSaving] = useState(false)
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [busyAction, setBusyAction] = useState<CommissionerActionId | null>(null)

    useEffect(() => {
        let cancelled = false
        async function load() {
            if (!league || hydratedLeagueId.current === league.id) {
                setLoading(false)
                return
            }
            setLoading(true)
            try {
                const [slotData, memberData] = await Promise.all([
                    getLineupSlots(league.id),
                    getLeagueMembers(league.id),
                ])
                if (cancelled) return
                const slots = Object.fromEntries(slotData.map((slot) => [slot.slot_type, slot.slot_count]))
                const source = league.scoring_settings && typeof league.scoring_settings === 'object' &&
                    !Array.isArray(league.scoring_settings) ? league.scoring_settings : {}
                const scoring = Object.fromEntries(COMMISSIONER_SCORING_FIELDS.map(({ key }) => [
                    key,
                    source[key] != null ? String(source[key]) : '0',
                ]))
                const nextDraft: CommissionerSettingsDraft = {
                    rosterSize: String(league.roster_size ?? 20),
                    irSlots: String(league.ir_slots ?? 2),
                    taxiSlots: String(league.taxi_slots ?? 0),
                    auctionBudget: String(league.auction_budget ?? 200),
                    playoffWeek: String(league.playoff_start_week ?? 20),
                    weeklyAddLimit: String(league.weekly_add_limit ?? 0),
                    waiverMode: waiverModeFromValue(league.waiver_mode),
                    faabBudget: String(league.faab_starting_budget ?? 100),
                    tradeVetoMode: tradeVetoModeFromValue(league.trade_veto_mode),
                    tradeVetoWindowHours: String(league.trade_veto_window_hours ?? 24),
                    tradeVetoThresholdPercent: String(league.trade_veto_threshold_percent ?? 50),
                    scoring,
                    slots,
                }
                setMembers(memberData)
                setOverrideMemberId(memberData[0]?.id ?? null)
                setDraft(nextDraft)
                setInitialDraft(nextDraft)
                hydratedLeagueId.current = league.id
            } catch (error) {
                showAlert('Could not load league settings', getErrorMessage(error))
            } finally {
                if (!cancelled) setLoading(false)
            }
        }
        void load()
        return () => { cancelled = true }
    }, [league])

    const updateField = <Key extends keyof CommissionerSettingsDraft>(
        key: Key,
        value: CommissionerSettingsDraft[Key],
    ) => setDraft((current) => ({ ...current, [key]: value }))

    const updateScoring = (key: string, value: string) => {
        setDraft((current) => ({ ...current, scoring: { ...current.scoring, [key]: value } }))
    }

    const adjustSlot = (type: string, delta: number) => {
        setDraft((current) => ({
            ...current,
            slots: { ...current.slots, [type]: Math.max(0, (current.slots[type] ?? 0) + delta) },
        }))
    }

    const save = async () => {
        if (!league) return
        const change = buildCommissionerSettingsChange(
            draft,
            initialDraft,
            league.status,
            COMMISSIONER_SCORING_FIELDS.map(({ key }) => key),
            LINEUP_SLOT_TYPES,
        )
        if ('error' in change) {
            showAlert('Invalid', change.error)
            return
        }
        setSaving(true)
        try {
            const generalChanged = Object.keys(change.updates).length > 0
            if (generalChanged || change.slotsChanged) {
                await updateLeagueConfiguration(league.id, change.updates, change.slotUpdates)
            }
            setInitialDraft(draft)
            await refresh()
            back()
        } catch (error) {
            showAlert('Error', getErrorMessage(error))
        } finally {
            setSaving(false)
        }
    }

    const handleFaabOverride = async () => {
        if (!league || !overrideMemberId) return
        const balance = Number.parseInt(overrideFaab, 10)
        if (!Number.isInteger(balance) || balance < 0) {
            showAlert('Invalid', 'FAAB balance must be 0 or more.')
            return
        }
        setOverrideSaving(true)
        try {
            await adjustFaabBalance(league.id, overrideMemberId, balance)
            setOverrideFaab('')
            showSuccess('Done', 'FAAB balance updated.')
        } catch (error) {
            showAlert('Error', getErrorMessage(error))
        } finally {
            setOverrideSaving(false)
        }
    }

    const handleAddCountOverride = async () => {
        if (!league || !overrideMemberId) return
        const addCount = Number.parseInt(overrideAdds, 10)
        if (!Number.isInteger(addCount) || addCount < 0) {
            showAlert('Invalid', 'Weekly add count must be 0 or more.')
            return
        }
        setOverrideSaving(true)
        try {
            await overrideWeeklyAddCount(league.id, overrideMemberId, addCount)
            setOverrideAdds('')
            showSuccess('Done', 'Weekly add count updated.')
        } catch (error) {
            showAlert('Error', getErrorMessage(error))
        } finally {
            setOverrideSaving(false)
        }
    }

    const runAdmin = (path: string, message: string, action: CommissionerActionId, body = {}) =>
        adminCall(path, message, action, setBusyAction, body)
    const generateSchedule = (force: boolean) => runAdmin(
        '/sync/matchups',
        force ? 'Schedule reset and regenerated.' : 'Schedule generated successfully.',
        force ? 'reset-schedule' : 'generate-schedule',
        { force },
    )
    const resetScheduleAction: CommissionerAction = {
        id: 'reset-schedule',
        label: 'Reset & Regenerate Schedule',
        color: colors.danger,
        description: 'Deletes every existing matchup and rebuilds the season schedule from scratch.',
        onPress: () => confirmAction(
            'Reset Schedule',
            'This will delete all existing matchups and regenerate. Are you sure?',
            () => generateSchedule(true),
            'Reset',
            true,
        ),
    }
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
        color: colors.primaryDark,
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
    const scheduleActions: CommissionerAction[] = [
        { id: 'generate-schedule', label: 'Generate Season Schedule', onPress: () => generateSchedule(false) },
        resetScheduleAction,
    ]
    const utilityActions: CommissionerAction[] = [
        { id: 'process-waivers', label: 'Process Waiver Claims', onPress: () => runAdmin('/waivers/process', 'Waiver claims processed.', 'process-waivers') },
        { id: 'sync-stats', label: 'Sync Player Stats', onPress: () => runAdmin('/sync/stats', 'Stats synced (last 7 days).', 'sync-stats', { days: 7 }) },
        { id: 'sync-scores', label: 'Sync Scores Now', onPress: () => runAdmin('/sync/scores', 'Scores synced.', 'sync-scores') },
        { id: 'sync-rankings', label: 'Sync Dynasty Rankings', onPress: () => runAdmin('/sync/rankings', 'Dynasty rankings synced.', 'sync-rankings') },
        { id: 'sync-projections', label: 'Sync Projections', onPress: () => runAdmin('/sync/projections', 'Projections synced.', 'sync-projections') },
        { id: 'sync-games', label: 'Sync NBA Game Schedule', onPress: () => runAdmin('/sync/schedule', 'Game schedule synced.', 'sync-games') },
    ]
    const { lifecycle, lowerPriorityActions } = commissionerLifecyclePolicy(league?.status ?? 'setup', {
        playoffActions,
        annualCycleActions,
        scheduleActions,
        utilityActions,
    })

    const handleDeleteLeague = () => {
        if (!league) return
        confirmAction(
            'Delete League',
            `This will archive ${league.name}, cancel any active drafts, and remove it from normal navigation. Global player and ranking data will not be deleted.`,
            async () => {
                setBusyAction('delete-league')
                try {
                    await deleteLeague(league.id)
                    await refresh()
                    showSuccess('League deleted', 'The league has been archived and hidden from your league list.')
                    back()
                } catch (error) {
                    showAlert('Error', getErrorMessage(error))
                } finally {
                    setBusyAction(null)
                }
            },
            'Delete League',
            true,
        )
    }

    return {
        adjustSlot,
        busyAction,
        draft,
        handleAddCountOverride,
        handleDeleteLeague,
        handleFaabOverride,
        isCommissioner,
        lifecycle,
        loading,
        lowerPriorityActions,
        members,
        navigateBack: () => replace('/league?tab=settings'),
        overrideAdds,
        overrideFaab,
        overrideMemberId,
        overrideSaving,
        save,
        saving,
        setOverrideAdds,
        setOverrideFaab,
        setOverrideMemberId,
        tradeVetoModeDescription: tradeVetoDescription(draft.tradeVetoMode),
        updateField,
        updateScoring,
    }
}
