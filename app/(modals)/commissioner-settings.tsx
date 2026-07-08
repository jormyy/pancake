import {
    View,
    Text,
    TextInput,
    Pressable,
    ScrollView,
    StyleSheet,
    useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { Stack, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import {
    adjustFaabBalance,
    deleteLeague,
    getLeagueMembers,
    getLineupSlots,
    overrideWeeklyAddCount,
    updateLeague,
    updateLineupSlots,
    type LeagueSettingsUpdate,
    type TradeVetoMode,
    type WaiverMode,
} from '@/lib/league'
import { advanceSeason } from '@/lib/rookieDraft'
import { apiPost } from '@/lib/shared/api'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { showAlert, showSuccess, confirmAction, getErrorMessage } from '@/lib/alert'

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
    } catch (e) {
        showAlert('Error', getErrorMessage(e))
    } finally {
        setBusyAction(null)
    }
}

const SCORING_FIELDS: { key: string; label: string }[] = [
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
]

const SLOT_TYPES = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE']

type SlotMap = Record<string, number>
type ScoringMap = Record<string, string> // string for TextInput, parsed on save
type LeagueStatus = 'setup' | 'drafting' | 'active' | 'playoffs' | 'offseason' | string
type CommissionerActionId =
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
type CommissionerAction = {
    id: CommissionerActionId
    label: string
    onPress: () => void | Promise<void>
    color?: string
    description?: string
}

export default function CommissionerSettingsScreen() {
    const { currentLeague, isCommissioner, refresh } = useLeagueContext()
    const router = useRouter()
    const { width, height } = useWindowDimensions()
    const compactLandscape = width >= 600 && height < 500
    const { back } = router
    const league = currentLeague
    const hydratedLeagueId = useRef<string | null>(null)

    const [scoring, setScoring] = useState<ScoringMap>({})
    const [slots, setSlots] = useState<SlotMap>({})
    const [initialSlots, setInitialSlots] = useState<SlotMap>({})
    const [rosterSize, setRosterSize] = useState('')
    const [irSlots, setIrSlots] = useState('')
    const [taxiSlots, setTaxiSlots] = useState('')
    const [auctionBudget, setAuctionBudget] = useState('')
    const [playoffWeek, setPlayoffWeek] = useState('')
    const [weeklyAddLimit, setWeeklyAddLimit] = useState('')
    const [waiverMode, setWaiverMode] = useState<WaiverMode>('faab')
    const [faabBudget, setFaabBudget] = useState('')
    const [tradeVetoMode, setTradeVetoMode] = useState<TradeVetoMode>('member_vote')
    const [tradeVetoWindowHours, setTradeVetoWindowHours] = useState('')
    const [tradeVetoThresholdPercent, setTradeVetoThresholdPercent] = useState('')
    const [members, setMembers] = useState<{ id: string; team_name: string | null }[]>([])
    const [overrideMemberId, setOverrideMemberId] = useState<string | null>(null)
    const [overrideFaab, setOverrideFaab] = useState('')
    const [overrideAdds, setOverrideAdds] = useState('')
    const [overrideSaving, setOverrideSaving] = useState(false)
    const [initialScoring, setInitialScoring] = useState<ScoringMap>({})
    const [initialGeneral, setInitialGeneral] = useState({
        rosterSize: '',
        irSlots: '',
        taxiSlots: '',
        auctionBudget: '',
        playoffWeek: '',
        weeklyAddLimit: '',
        waiverMode: 'faab' as WaiverMode,
        faabBudget: '',
        tradeVetoMode: 'member_vote' as TradeVetoMode,
        tradeVetoWindowHours: '',
        tradeVetoThresholdPercent: '',
    })
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [busyAction, setBusyAction] = useState<CommissionerActionId | null>(null)

    useEffect(() => {
        let cancelled = false

        async function load() {
            if (!league) {
                setLoading(false)
                return
            }
            if (hydratedLeagueId.current === league.id) {
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
                const slotMap: SlotMap = {}
                for (const s of slotData) slotMap[s.slot_type] = s.slot_count
                setSlots(slotMap)
                setInitialSlots(slotMap)
                setMembers(memberData)
                setOverrideMemberId((prev) => prev ?? memberData[0]?.id ?? null)

                const s =
                    league.scoring_settings &&
                    typeof league.scoring_settings === 'object' &&
                    !Array.isArray(league.scoring_settings)
                        ? league.scoring_settings as Record<string, unknown>
                        : {}
                const scoreMap: ScoringMap = {}
                for (const { key } of SCORING_FIELDS) {
                    scoreMap[key] = s[key] != null ? String(s[key]) : '0'
                }
                setScoring(scoreMap)
                setInitialScoring(scoreMap)

                const general = {
                    rosterSize: String(league.roster_size ?? 20),
                    irSlots: String(league.ir_slots ?? 2),
                    taxiSlots: String(league.taxi_slots ?? 0),
                    auctionBudget: String(league.auction_budget ?? 200),
                    playoffWeek: String(league.playoff_start_week ?? 20),
                    weeklyAddLimit: String(league.weekly_add_limit ?? 0),
                    waiverMode: (league.waiver_mode ?? 'faab') as WaiverMode,
                    faabBudget: String(league.faab_starting_budget ?? 100),
                    tradeVetoMode: (league.trade_veto_mode ?? 'member_vote') as TradeVetoMode,
                    tradeVetoWindowHours: String(league.trade_veto_window_hours ?? 24),
                    tradeVetoThresholdPercent: String(league.trade_veto_threshold_percent ?? 50),
                }
                setRosterSize(general.rosterSize)
                setIrSlots(general.irSlots)
                setTaxiSlots(general.taxiSlots)
                setAuctionBudget(general.auctionBudget)
                setPlayoffWeek(general.playoffWeek)
                setWeeklyAddLimit(general.weeklyAddLimit)
                setWaiverMode(general.waiverMode)
                setFaabBudget(general.faabBudget)
                setTradeVetoMode(general.tradeVetoMode)
                setTradeVetoWindowHours(general.tradeVetoWindowHours)
                setTradeVetoThresholdPercent(general.tradeVetoThresholdPercent)
                setInitialGeneral(general)
                hydratedLeagueId.current = league.id
            } catch (e) {
                console.error(e)
            } finally {
                if (!cancelled) setLoading(false)
            }
        }
        load()

        return () => {
            cancelled = true
        }
    }, [league])

    function adjustSlot(type: string, delta: number) {
        setSlots((prev) => {
            const next = Math.max(0, (prev[type] ?? 0) + delta)
            return { ...prev, [type]: next }
        })
    }

    async function save() {
        if (!league) return

        const parsedRoster = parseInt(rosterSize)
        const parsedIR = parseInt(irSlots)
        const parsedTaxi = parseInt(taxiSlots)
        const parsedBudget = parseInt(auctionBudget)
        const parsedPlayoff = parseInt(playoffWeek)
        const parsedWeeklyAddLimit = parseInt(weeklyAddLimit)
        const parsedFaabBudget = parseInt(faabBudget)
        const parsedVetoWindowHours = parseInt(tradeVetoWindowHours)
        const parsedVetoThresholdPercent = parseInt(tradeVetoThresholdPercent)

        if (isNaN(parsedRoster) || parsedRoster < 1) {
            showAlert('Invalid', 'Roster size must be at least 1.')
            return
        }
        if (isNaN(parsedIR) || parsedIR < 0) {
            showAlert('Invalid', 'IR slots must be 0 or more.')
            return
        }
        if (isNaN(parsedTaxi) || parsedTaxi < 0) {
            showAlert('Invalid', 'Taxi squad slots must be 0 or more.')
            return
        }
        if (isNaN(parsedBudget) || parsedBudget < 1) {
            showAlert('Invalid', 'Auction budget must be at least 1.')
            return
        }
        if (isNaN(parsedPlayoff) || parsedPlayoff < 18 || parsedPlayoff > 24) {
            showAlert('Invalid', 'Playoff start week must be between 18 and 24.')
            return
        }
        if (isNaN(parsedWeeklyAddLimit) || parsedWeeklyAddLimit < 0) {
            showAlert('Invalid', 'Weekly add limit must be 0 or more.')
            return
        }
        if (isNaN(parsedFaabBudget) || parsedFaabBudget < 0) {
            showAlert('Invalid', 'FAAB starting budget must be 0 or more.')
            return
        }
        if (!['disabled', 'commissioner', 'member_vote'].includes(tradeVetoMode)) {
            showAlert('Invalid', 'Choose a valid trade veto mode.')
            return
        }
        if (tradeVetoMode === 'disabled') {
            if (isNaN(parsedVetoWindowHours) || parsedVetoWindowHours < 0 || parsedVetoWindowHours > 168) {
                showAlert('Invalid', 'Veto window must be between 0 and 168 hours.')
                return
            }
        } else if (isNaN(parsedVetoWindowHours) || parsedVetoWindowHours < 1 || parsedVetoWindowHours > 168) {
            showAlert('Invalid', 'Veto window must be between 1 and 168 hours.')
            return
        }
        if (isNaN(parsedVetoThresholdPercent) || parsedVetoThresholdPercent < 1 || parsedVetoThresholdPercent > 100) {
            showAlert('Invalid', 'Member veto threshold must be between 1% and 100%.')
            return
        }

        const scoringSettings: Record<string, number> = {}
        for (const { key } of SCORING_FIELDS) {
            const val = parseFloat(scoring[key] ?? '0')
            scoringSettings[key] = isNaN(val) ? 0 : val
        }

        const slotsChanged = SLOT_TYPES.some((type) => (slots[type] ?? 0) !== (initialSlots[type] ?? 0))
        const canUpdateSlots = (league.status as LeagueStatus) === 'setup'
        if (slotsChanged && !canUpdateSlots) {
            showAlert('Invalid', 'Lineup slots can only be changed during league setup.')
            return
        }

        const scoringChanged = SCORING_FIELDS.some(({ key }) => scoring[key] !== initialScoring[key])
        const updates: LeagueSettingsUpdate = {}
        if (scoringChanged) updates.scoring_settings = scoringSettings
        if (rosterSize !== initialGeneral.rosterSize) updates.roster_size = parsedRoster
        if (irSlots !== initialGeneral.irSlots) updates.ir_slots = parsedIR
        if (taxiSlots !== initialGeneral.taxiSlots) updates.taxi_slots = parsedTaxi
        if (auctionBudget !== initialGeneral.auctionBudget) updates.auction_budget = parsedBudget
        if (playoffWeek !== initialGeneral.playoffWeek) updates.playoff_start_week = parsedPlayoff
        if (weeklyAddLimit !== initialGeneral.weeklyAddLimit) {
            updates.weekly_add_unlimited = parsedWeeklyAddLimit === 0
            if (parsedWeeklyAddLimit > 0) updates.weekly_add_limit = parsedWeeklyAddLimit
        }
        if (waiverMode !== initialGeneral.waiverMode) updates.waiver_mode = waiverMode
        if (faabBudget !== initialGeneral.faabBudget) updates.faab_starting_budget = parsedFaabBudget
        if (tradeVetoMode !== initialGeneral.tradeVetoMode) updates.trade_veto_mode = tradeVetoMode
        if (tradeVetoWindowHours !== initialGeneral.tradeVetoWindowHours) updates.trade_veto_window_hours = parsedVetoWindowHours
        if (tradeVetoThresholdPercent !== initialGeneral.tradeVetoThresholdPercent) updates.trade_veto_threshold_percent = parsedVetoThresholdPercent

        setSaving(true)
        try {
            if (Object.keys(updates).length > 0) {
                await updateLeague(league.id, updates)
                setInitialScoring(scoring)
                setInitialGeneral({
                    rosterSize,
                    irSlots,
                    taxiSlots,
                    auctionBudget,
                    playoffWeek,
                    weeklyAddLimit,
                    waiverMode,
                    faabBudget,
                    tradeVetoMode,
                    tradeVetoWindowHours,
                    tradeVetoThresholdPercent,
                })
            }
            if (slotsChanged) {
                await updateLineupSlots(
                    league.id,
                    SLOT_TYPES.map((t) => ({ slot_type: t, slot_count: slots[t] ?? 0 })),
                )
                setInitialSlots(slots)
            }
            await refresh()
            back()
        } catch (e) {
            showAlert('Error', getErrorMessage(e))
        } finally {
            setSaving(false)
        }
    }

    async function syncStats() {
        await adminCall('/sync/stats', 'Stats synced (last 7 days).', 'sync-stats', setBusyAction, { days: 7 })
    }

    async function syncScores() {
        await adminCall('/sync/scores', 'Scores synced.', 'sync-scores', setBusyAction)
    }

    async function syncGameSchedule() {
        await adminCall('/sync/schedule', 'Game schedule synced.', 'sync-games', setBusyAction)
    }

    async function processWaivers() {
        await adminCall('/waivers/process', 'Waiver claims processed.', 'process-waivers', setBusyAction)
    }

    async function syncRankings() {
        await adminCall('/sync/rankings', 'Dynasty rankings synced.', 'sync-rankings', setBusyAction)
    }

    async function syncProjections() {
        await adminCall('/sync/projections', 'Projections synced.', 'sync-projections', setBusyAction)
    }

    async function generatePlayoffBracket() {
        if (!league?.id) return
        await adminCall(
            '/playoffs/generate',
            'Semifinal bracket generated.',
            'generate-playoffs',
            setBusyAction,
            { leagueId: league.id },
        )
    }

    async function advancePlayoffBracket() {
        if (!league?.id) return
        await adminCall(
            '/playoffs/advance',
            'Championship matchup created.',
            'advance-playoffs',
            setBusyAction,
            { leagueId: league.id },
        )
    }

    async function handleAdvanceSeason() {
        if (!league?.id) return
        confirmAction(
            'Advance Season',
            'This will create a new season, carry rosters forward, and set the league to offseason. Continue?',
            async () => {
                setBusyAction('advance-season')
                try {
                    await advanceSeason(league.id)
                    showSuccess('Done', 'Season advanced. Start the rookie draft when ready.')
                    await refresh()
                } catch (e) {
                    showAlert('Error', getErrorMessage(e))
                } finally {
                    setBusyAction(null)
                }
            },
            'Advance',
            true,
        )
    }

    async function handleDeleteLeague() {
        if (!league?.id) return
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
                } catch (e) {
                    showAlert('Error', getErrorMessage(e))
                } finally {
                    setBusyAction(null)
                }
            },
            'Delete League',
            true,
        )
    }

    async function generateSchedule(force = false) {
        await adminCall(
            '/sync/matchups',
            force ? 'Schedule reset and regenerated.' : 'Schedule generated successfully.',
            // Distinct ids so only the pressed button shows its busy spinner.
            force ? 'reset-schedule' : 'generate-schedule',
            setBusyAction,
            { force },
        )
    }

    async function handleFaabOverride() {
        if (!league?.id || !overrideMemberId) return
        const balance = parseInt(overrideFaab)
        if (isNaN(balance) || balance < 0) {
            showAlert('Invalid', 'FAAB balance must be 0 or more.')
            return
        }
        setOverrideSaving(true)
        try {
            await adjustFaabBalance(league.id, overrideMemberId, balance)
            showSuccess('Done', 'FAAB balance updated.')
            setOverrideFaab('')
        } catch (e) {
            showAlert('Error', getErrorMessage(e))
        } finally {
            setOverrideSaving(false)
        }
    }

    async function handleAddCountOverride() {
        if (!league?.id || !overrideMemberId) return
        const addCount = parseInt(overrideAdds)
        if (isNaN(addCount) || addCount < 0) {
            showAlert('Invalid', 'Weekly add count must be 0 or more.')
            return
        }
        setOverrideSaving(true)
        try {
            await overrideWeeklyAddCount(league.id, overrideMemberId, addCount)
            showSuccess('Done', 'Weekly add count updated.')
            setOverrideAdds('')
        } catch (e) {
            showAlert('Error', getErrorMessage(e))
        } finally {
            setOverrideSaving(false)
        }
    }

    const resetScheduleAction: CommissionerAction = {
        id: 'reset-schedule',
        label: 'Reset & Regenerate Schedule',
        color: colors.danger,
        description: 'Deletes every existing matchup and rebuilds the season schedule from scratch.',
        onPress: () =>
            confirmAction(
                'Reset Schedule',
                'This will delete all existing matchups and regenerate. Are you sure?',
                () => generateSchedule(true),
                'Reset',
                true,
            ),
    }
    const playoffActions: CommissionerAction[] = [
        { id: 'generate-playoffs', label: 'Generate Playoff Bracket', onPress: generatePlayoffBracket },
        {
            id: 'advance-playoffs',
            label: 'Advance to Championship',
            onPress: advancePlayoffBracket,
            description: 'Finalizes the semifinal results and creates the championship matchup. Semifinal scores cannot change after this.',
        },
    ]
    const annualCycleActions: CommissionerAction[] = [
        {
            id: 'advance-season',
            label: 'Advance to Next Season',
            color: colors.primaryDark,
            onPress: handleAdvanceSeason,
            description: 'Closes the current season and rolls all teams into the next league year. The finished season becomes read-only history.',
        },
    ]
    const scheduleActions: CommissionerAction[] = [
        { id: 'generate-schedule', label: 'Generate Season Schedule', onPress: () => generateSchedule(false) },
        resetScheduleAction,
    ]
    const utilityActions: CommissionerAction[] = [
        { id: 'process-waivers', label: 'Process Waiver Claims', onPress: processWaivers },
        { id: 'sync-stats', label: 'Sync Player Stats', onPress: syncStats },
        { id: 'sync-scores', label: 'Sync Scores Now', onPress: syncScores },
        { id: 'sync-rankings', label: 'Sync Dynasty Rankings', onPress: syncRankings },
        { id: 'sync-projections', label: 'Sync Projections', onPress: syncProjections },
        { id: 'sync-games', label: 'Sync NBA Game Schedule', onPress: syncGameSchedule },
    ]

    const status = (league?.status as LeagueStatus | undefined) ?? 'setup'
    const lifecycle =
        status === 'playoffs'
            ? {
                  label: 'Playoff Controls',
                  detail: 'Generate the bracket or advance after each playoff round is finalized.',
                  actions: playoffActions,
              }
            : status === 'offseason'
              ? {
                    label: 'Annual Cycle',
                    detail: 'Create the next season when rosters and results are ready to roll forward.',
                    actions: annualCycleActions,
                }
              : {
                    label: 'Schedule Controls',
                    detail: 'Build or reset the regular-season schedule before managers rely on matchups.',
                    actions: scheduleActions,
                }

    const lowerPriorityActions = [...utilityActions]
    if (status !== 'playoffs') lowerPriorityActions.push(...playoffActions)
    if (status !== 'offseason') lowerPriorityActions.push(...annualCycleActions)
    if (status === 'playoffs' || status === 'offseason') lowerPriorityActions.push(...scheduleActions)

    const tradeVetoModeDescription =
        tradeVetoMode === 'disabled'
            ? 'Accepted trades complete immediately with no veto period.'
            : tradeVetoMode === 'commissioner'
              ? 'Accepted trades wait through the window; only commissioners can veto.'
              : 'Accepted trades wait through the window; non-party member votes can veto at the configured threshold.'

    function renderAction(action: CommissionerAction, grid = false) {
        const color = action.color ?? colors.primary
        const accessibilityLabel = action.description ? `${action.label}. ${action.description}` : action.label
        const button = (
            <Pressable
                key={`${action.id}:${action.label}`}
                style={[styles.actionButton, grid && !action.description && styles.actionButtonGrid, { borderColor: color }]}
                onPress={action.onPress}
                disabled={busyAction !== null}
                role="button"
                aria-label={accessibilityLabel}
                aria-disabled={busyAction !== null}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                accessibilityState={{ disabled: busyAction !== null }}
            >
                <Text style={[styles.actionButtonText, { color }]}>{action.label}</Text>
            </Pressable>
        )
        if (!action.description) return button
        return (
            <View key={`${action.id}:${action.label}`} style={[styles.actionWrap, grid && styles.actionButtonGrid]}>
                {button}
                <Text style={styles.actionDescription}>{action.description}</Text>
            </View>
        )
    }

    return (
        <>
            <Stack.Screen options={{ title: 'League Settings', presentation: 'modal', headerShown: false }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                <View style={styles.screenHeader}>
                    <Pressable
                        onPress={() => router.replace('/league?tab=settings')}
                        style={styles.headerBack}
                        role="link"
                        aria-label="Back to league settings"
                        accessibilityRole="link"
                        accessibilityLabel="Back to league settings"
                    >
                        <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
                    </Pressable>
                    <Text style={styles.screenTitle}>League Settings</Text>
                </View>
                <ScrollView
                    contentContainerStyle={[styles.scroll, compactLandscape && styles.scrollCompact]}
                    keyboardShouldPersistTaps="handled"
                >
                    <View style={[styles.lifecycleCard, compactLandscape && styles.lifecycleCardCompact]}>
                        <View style={styles.lifecycleCopy}>
                            <Text style={styles.lifecycleTitle}>{lifecycle.label}</Text>
                            <Text style={styles.lifecycleDetail}>{lifecycle.detail}</Text>
                        </View>
                        <View style={[styles.lifecycleActions, compactLandscape && styles.lifecycleActionsCompact]}>
                            {lifecycle.actions.map((action) => renderAction(action, true))}
                        </View>
                    </View>

                    {/* ── Scoring ────────────────────────────────────── */}
                    <Text style={styles.sectionTitle}>SCORING</Text>
                    <View style={styles.card}>
                        {SCORING_FIELDS.map(({ key, label }, i) => (
                            <View
                                key={key}
                                style={[
                                    styles.row,
                                    i < SCORING_FIELDS.length - 1 && styles.rowBorder,
                                ]}
                            >
                                <Text style={styles.rowLabel}>{label}</Text>
                                <TextInput
                                    style={styles.scoreInput}
                                    value={scoring[key] ?? ''}
                                    onChangeText={(v) => {
                                        // Allow: leading minus, digits, one decimal point
                                        if (/^-?\d*\.?\d*$/.test(v) || v === '-') {
                                            setScoring((prev) => ({ ...prev, [key]: v }))
                                        }
                                    }}
                                    keyboardType="default"
                                    selectTextOnFocus
                                />
                            </View>
                        ))}
                    </View>

                    {/* ── Lineup Slots ───────────────────────────────── */}
                    <Text style={styles.sectionTitle}>LINEUP SLOTS</Text>
                    <View style={styles.card}>
                        {SLOT_TYPES.map((type, i) => (
                            <View
                                key={type}
                                style={[styles.row, i < SLOT_TYPES.length - 1 && styles.rowBorder]}
                            >
                                <Text style={styles.rowLabel}>{type}</Text>
                                <View style={styles.stepper}>
                                    <Pressable
                                        style={styles.stepBtn}
                                        onPress={() => adjustSlot(type, -1)}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Decrease ${type} slots`}
                                        hitSlop={8}
                                    >
                                        <Text style={styles.stepBtnText}>−</Text>
                                    </Pressable>
                                    <Text style={styles.stepValue}>{slots[type] ?? 0}</Text>
                                    <Pressable
                                        style={styles.stepBtn}
                                        onPress={() => adjustSlot(type, 1)}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Increase ${type} slots`}
                                        hitSlop={8}
                                    >
                                        <Text style={styles.stepBtnText}>+</Text>
                                    </Pressable>
                                </View>
                            </View>
                        ))}
                    </View>

                    {/* ── General ───────────────────────────────────── */}
                    <Text style={styles.sectionTitle}>GENERAL</Text>
                    <View style={styles.card}>
                        {[
                            { label: 'Active Roster Size', value: rosterSize, set: setRosterSize },
                            { label: 'IR Slots', value: irSlots, set: setIrSlots },
                            { label: 'Taxi Squad Slots', value: taxiSlots, set: setTaxiSlots },
                            {
                                label: 'Auction Budget ($)',
                                value: auctionBudget,
                                set: setAuctionBudget,
                            },
                            {
                                label: 'Playoff Start Week (18–24)',
                                value: playoffWeek,
                                set: setPlayoffWeek,
                            },
                            {
                                label: 'Weekly Add Limit (0 = unlimited)',
                                value: weeklyAddLimit,
                                set: setWeeklyAddLimit,
                            },
                            {
                                label: 'FAAB Starting Budget',
                                value: faabBudget,
                                set: setFaabBudget,
                            },
                        ].map(({ label, value, set }, i, arr) => (
                            <View
                                key={label}
                                style={[styles.row, i < arr.length - 1 && styles.rowBorder]}
                            >
                                <Text style={styles.rowLabel}>{label}</Text>
                                <TextInput
                                    style={styles.scoreInput}
                                    value={value}
                                    onChangeText={set}
                                    keyboardType="numeric"
                                    selectTextOnFocus
                                />
                            </View>
                        ))}
                        <View style={[styles.row, styles.rowBorder]}>
                            <Text style={styles.rowLabel}>Waiver Mode</Text>
                            <View style={styles.segmentRow}>
                                {(['faab', 'rolling'] as WaiverMode[]).map((mode) => {
                                    const active = waiverMode === mode
                                    return (
                                        <Pressable
                                            key={mode}
                                            style={[styles.segmentButton, active && styles.segmentButtonActive]}
                                            onPress={() => setWaiverMode(mode)}
                                        >
                                            <Text style={[styles.segmentButtonText, active && styles.segmentButtonTextActive]}>
                                                {mode === 'faab' ? 'FAAB' : 'Rolling'}
                                            </Text>
                                        </Pressable>
                                    )
                                })}
                            </View>
                        </View>
                    </View>

                    <Text style={styles.sectionTitle}>TRADE VETO</Text>
                    <View style={styles.card}>
                        <View style={[styles.row, styles.rowBorder]}>
                            <Text style={styles.rowLabel}>Veto Mode</Text>
                            <View style={styles.segmentRow}>
                                {([
                                    { value: 'member_vote', label: 'Members' },
                                    { value: 'commissioner', label: 'Commish' },
                                    { value: 'disabled', label: 'Off' },
                                ] as { value: TradeVetoMode; label: string }[]).map((mode) => {
                                    const active = tradeVetoMode === mode.value
                                    return (
                                        <Pressable
                                            key={mode.value}
                                            style={[styles.segmentButton, active && styles.segmentButtonActive]}
                                            onPress={() => setTradeVetoMode(mode.value)}
                                        >
                                            <Text style={[styles.segmentButtonText, active && styles.segmentButtonTextActive]}>
                                                {mode.label}
                                            </Text>
                                        </Pressable>
                                    )
                                })}
                            </View>
                        </View>
                        <Text style={styles.settingHint}>{tradeVetoModeDescription}</Text>
                        <View style={[styles.row, styles.rowBorder]}>
                            <Text style={styles.rowLabel}>Veto Window Hours</Text>
                            <TextInput
                                style={styles.scoreInput}
                                value={tradeVetoWindowHours}
                                onChangeText={setTradeVetoWindowHours}
                                keyboardType="numeric"
                                selectTextOnFocus
                            />
                        </View>
                        <View style={styles.row}>
                            <Text style={styles.rowLabel}>Member Threshold %</Text>
                            <TextInput
                                style={styles.scoreInput}
                                value={tradeVetoThresholdPercent}
                                onChangeText={setTradeVetoThresholdPercent}
                                keyboardType="numeric"
                                selectTextOnFocus
                            />
                        </View>
                    </View>

                    <Text style={styles.sectionTitle}>TRANSACTION OVERRIDES</Text>
                    <View style={styles.card}>
                        <View style={styles.memberChipRow}>
                            {members.map((member) => {
                                const active = overrideMemberId === member.id
                                return (
                                    <Pressable
                                        key={member.id}
                                        style={[styles.memberChip, active && styles.memberChipActive]}
                                        onPress={() => setOverrideMemberId(member.id)}
                                    >
                                        <Text style={[styles.memberChipText, active && styles.memberChipTextActive]}>
                                            {member.team_name ?? 'Unnamed'}
                                        </Text>
                                    </Pressable>
                                )
                            })}
                        </View>
                        <View style={styles.overrideRow}>
                            <TextInput
                                style={styles.overrideInput}
                                value={overrideFaab}
                                onChangeText={setOverrideFaab}
                                keyboardType="numeric"
                                placeholder="FAAB balance"
                                placeholderTextColor={colors.textPlaceholder}
                            />
                            <Pressable style={styles.overrideButton} onPress={handleFaabOverride} disabled={overrideSaving}>
                                <Text style={styles.overrideButtonText}>Set FAAB</Text>
                            </Pressable>
                        </View>
                        <View style={styles.overrideRow}>
                            <TextInput
                                style={styles.overrideInput}
                                value={overrideAdds}
                                onChangeText={setOverrideAdds}
                                keyboardType="numeric"
                                placeholder="Weekly adds used"
                                placeholderTextColor={colors.textPlaceholder}
                            />
                            <Pressable style={styles.overrideButton} onPress={handleAddCountOverride} disabled={overrideSaving}>
                                <Text style={styles.overrideButtonText}>Set Adds</Text>
                            </Pressable>
                        </View>
                    </View>

                    {/* ── Save ──────────────────────────────────────── */}
                    <Pressable
                        style={[styles.saveButton, loading && styles.saveButtonDisabled]}
                        onPress={save}
                        disabled={saving || loading}
                    >
                        <Text style={styles.saveButtonText}>Save Settings</Text>
                    </Pressable>

                    <Text style={styles.sectionTitle}>COMMISSIONER ACTIONS</Text>
                    {lowerPriorityActions.map((action) => renderAction(action))}

                    {isCommissioner ? (
                        <>
                            <Text style={styles.sectionTitle}>DANGER ZONE</Text>
                            {renderAction({
                                id: 'delete-league',
                                label: 'Delete League',
                                color: colors.danger,
                                onPress: handleDeleteLeague,
                                description: 'Permanently removes the league, all rosters, history, and picks for every manager. This cannot be undone.',
                            })}
                        </>
                    ) : null}
                </ScrollView>
            </SafeAreaView>
        </>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgSubtle },
    scroll: { padding: spacing['2xl'], gap: spacing.md, paddingBottom: 96, width: '100%', maxWidth: 760, alignSelf: 'center' },
    scrollCompact: { paddingHorizontal: spacing.md, paddingTop: spacing.md, gap: spacing.sm, paddingBottom: spacing['5xl'] },

    screenHeader: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    headerBack: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    screenTitle: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: fontSize.lg,
        fontWeight: fontWeight.extrabold,
    },

    lifecycleCard: {
        backgroundColor: colors.bgScreen,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        padding: spacing.xl,
        gap: spacing.lg,
    },
    lifecycleCardCompact: {
        padding: spacing.md,
        gap: spacing.md,
    },
    lifecycleCopy: {
        gap: spacing.xs,
    },
    lifecycleTitle: {
        fontSize: fontSize.lg,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    lifecycleDetail: {
        fontSize: fontSize.sm,
        lineHeight: 18,
        color: colors.textSecondary,
    },
    lifecycleActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.md,
    },
    lifecycleActionsCompact: {
        gap: spacing.sm,
    },

    sectionTitle: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0,
        marginTop: spacing.lg,
        marginBottom: spacing.xs,
        marginLeft: spacing.xs,
    },

    card: {
        backgroundColor: colors.bgScreen,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        overflow: 'hidden',
    },
    row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg },
    rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.separator },
    rowLabel: { flex: 1, fontSize: 15, color: colors.textPrimary },
    settingHint: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        fontSize: fontSize.sm,
        lineHeight: 18,
        color: colors.textMuted,
    },

    scoreInput: {
        width: 72,
        minHeight: 44,
        textAlign: 'right',
        fontSize: 15,
        fontWeight: fontWeight.semibold,
        color: colors.primaryDark,
        padding: 0,
    },
    segmentRow: {
        flexDirection: 'row',
        gap: spacing.sm,
    },
    segmentButton: {
        minWidth: 76,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.md,
        backgroundColor: colors.bgMuted,
    },
    segmentButtonActive: {
        borderColor: colors.primary,
        backgroundColor: colors.primary,
    },
    segmentButtonText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textSecondary },
    segmentButtonTextActive: { color: colors.textWhite },
    memberChipRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
        padding: spacing.lg,
        paddingBottom: spacing.sm,
    },
    memberChip: {
        minHeight: 44,
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        paddingHorizontal: spacing.md,
    },
    memberChipActive: { backgroundColor: colors.primary },
    memberChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textSecondary },
    memberChipTextActive: { color: colors.textWhite },
    overrideRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
    },
    overrideInput: {
        flex: 1,
        minHeight: 44,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.md,
        fontSize: fontSize.md,
        color: colors.textPrimary,
    },
    overrideButton: {
        minWidth: 92,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
        paddingHorizontal: spacing.md,
    },
    overrideButtonText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textWhite },

    stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
    stepBtn: {
        width: 44,
        height: 44,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        justifyContent: 'center',
        alignItems: 'center',
    },
    stepBtnText: { fontSize: 20, color: colors.textPrimary, lineHeight: 24 },
    stepValue: {
        fontSize: fontSize.lg,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        minWidth: 20,
        textAlign: 'center',
    },

    saveButton: {
        marginTop: spacing.xl,
        backgroundColor: colors.primary,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        height: 52,
        justifyContent: 'center',
        alignItems: 'center',
    },
    saveButtonDisabled: { opacity: 0.55 },
    saveButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.lg },

    actionButton: {
        backgroundColor: colors.bgScreen,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1.5,
        borderColor: colors.primary,
        minHeight: 44,
        height: 52,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
    },
    actionButtonGrid: {
        flexGrow: 1,
        flexBasis: 184,
    },
    actionButtonText: { color: colors.primaryDark, fontWeight: fontWeight.bold, fontSize: fontSize.lg },
    actionWrap: { gap: spacing.xs },
    actionDescription: {
        fontSize: fontSize.xs,
        lineHeight: 16,
        color: colors.textMuted,
        paddingHorizontal: spacing.xs,
    },
})
