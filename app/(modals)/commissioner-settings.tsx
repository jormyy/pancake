import {
    View,
    Text,
    TextInput,
    Pressable,
    ScrollView,
    StyleSheet,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
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
}

export default function CommissionerSettingsScreen() {
    const { currentLeague, isCommissioner, refresh } = useLeagueContext()
    const { back } = useRouter()
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
                }
                setRosterSize(general.rosterSize)
                setIrSlots(general.irSlots)
                setTaxiSlots(general.taxiSlots)
                setAuctionBudget(general.auctionBudget)
                setPlayoffWeek(general.playoffWeek)
                setWeeklyAddLimit(general.weeklyAddLimit)
                setWaiverMode(general.waiverMode)
                setFaabBudget(general.faabBudget)
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

        setSaving(true)
        try {
            if (Object.keys(updates).length > 0) {
                await updateLeague(league.id, updates)
                setInitialScoring(scoring)
                setInitialGeneral({ rosterSize, irSlots, taxiSlots, auctionBudget, playoffWeek, weeklyAddLimit, waiverMode, faabBudget })
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

    const actionGroups: CommissionerAction[][] = [
        [
            { id: 'generate-playoffs', label: 'Generate Playoff Bracket', onPress: generatePlayoffBracket },
            { id: 'advance-playoffs', label: 'Advance to Championship', onPress: advancePlayoffBracket },
            { id: 'process-waivers', label: 'Process Waiver Claims', onPress: processWaivers },
            { id: 'sync-stats', label: 'Sync Player Stats', onPress: syncStats },
            { id: 'sync-scores', label: 'Sync Scores Now', onPress: syncScores },
            { id: 'sync-rankings', label: 'Sync Dynasty Rankings', onPress: syncRankings },
            { id: 'sync-projections', label: 'Sync Projections', onPress: syncProjections },
            { id: 'sync-games', label: 'Sync NBA Game Schedule', onPress: syncGameSchedule },
            { id: 'generate-schedule', label: 'Generate Season Schedule', onPress: () => generateSchedule(false) },
            {
                id: 'reset-schedule',
                label: 'Reset & Regenerate Schedule',
                color: colors.danger,
                onPress: () =>
                    confirmAction(
                        'Reset Schedule',
                        'This will delete all existing matchups and regenerate. Are you sure?',
                        () => generateSchedule(true),
                        'Reset',
                        true,
                    ),
            },
        ],
        [
            {
                id: 'advance-season',
                label: 'Advance to Next Season',
                color: colors.info,
                onPress: handleAdvanceSeason,
            },
        ],
    ]

    function renderAction(action: CommissionerAction) {
        const color = action.color ?? colors.primary
        return (
            <Pressable
                key={`${action.id}:${action.label}`}
                style={[styles.actionButton, { borderColor: color }]}
                onPress={action.onPress}
                disabled={busyAction !== null}
            >
                <Text style={[styles.actionButtonText, { color }]}>{action.label}</Text>
            </Pressable>
        )
    }

    return (
        <>
            <Stack.Screen options={{ title: 'League Settings', presentation: 'modal' }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                <ScrollView
                    contentContainerStyle={styles.scroll}
                    keyboardShouldPersistTaps="handled"
                >
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
                    {actionGroups[0].map(renderAction)}

                    <Text style={styles.sectionTitle}>ANNUAL CYCLE</Text>
                    {actionGroups[1].map(renderAction)}

                    {isCommissioner ? (
                        <>
                            <Text style={styles.sectionTitle}>DANGER ZONE</Text>
                            {renderAction({
                                id: 'delete-league',
                                label: 'Delete League',
                                color: colors.danger,
                                onPress: handleDeleteLeague,
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
    scroll: { padding: spacing['2xl'], gap: spacing.md, paddingBottom: 96 },

    sectionTitle: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0.8,
        marginTop: spacing.lg,
        marginBottom: spacing.xs,
        marginLeft: spacing.xs,
    },

    card: {
        backgroundColor: colors.bgScreen,
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        overflow: 'hidden',
    },
    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg },
    rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.separator },
    rowLabel: { flex: 1, fontSize: 15, color: colors.textPrimary },

    scoreInput: {
        width: 72,
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
        minHeight: 34,
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
        minHeight: 34,
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
        minHeight: 42,
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
        minHeight: 42,
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
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        height: 52,
        justifyContent: 'center',
        alignItems: 'center',
    },
    saveButtonDisabled: { opacity: 0.55 },
    saveButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.lg },

    actionButton: {
        backgroundColor: colors.bgScreen,
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        borderWidth: 1.5,
        borderColor: colors.primary,
        height: 52,
        justifyContent: 'center',
        alignItems: 'center',
    },
    actionButtonText: { color: colors.primaryDark, fontWeight: fontWeight.bold, fontSize: fontSize.lg },
})
