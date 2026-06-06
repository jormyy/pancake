import {
    View,
    Text,
    TextInput,
    Pressable,
    ScrollView,
    StyleSheet,
    ActivityIndicator,
    Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { getLineupSlots, updateLeague, updateLineupSlots } from '@/lib/league'
import { advanceSeason } from '@/lib/rookieDraft'
import { apiPost } from '@/lib/shared/api'
import { LoadingScreen } from '@/components/LoadingScreen'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { getErrorMessage } from '@/lib/alert'

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
        Alert.alert('Done', successMessage)
    } catch (e) {
        Alert.alert('Error', getErrorMessage(e))
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
    | 'advance-season'
type CommissionerAction = {
    id: CommissionerActionId
    label: string
    onPress: () => void | Promise<void>
    color?: string
}

export default function CommissionerSettingsScreen() {
    const { currentLeague, refresh } = useLeagueContext()
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
    const [initialScoring, setInitialScoring] = useState<ScoringMap>({})
    const [initialGeneral, setInitialGeneral] = useState({
        rosterSize: '',
        irSlots: '',
        taxiSlots: '',
        auctionBudget: '',
        playoffWeek: '',
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
                const slotData = await getLineupSlots(league.id)
                if (cancelled) return
                const slotMap: SlotMap = {}
                for (const s of slotData) slotMap[s.slot_type] = s.slot_count
                setSlots(slotMap)
                setInitialSlots(slotMap)

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
                }
                setRosterSize(general.rosterSize)
                setIrSlots(general.irSlots)
                setTaxiSlots(general.taxiSlots)
                setAuctionBudget(general.auctionBudget)
                setPlayoffWeek(general.playoffWeek)
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

        if (isNaN(parsedRoster) || parsedRoster < 1) {
            Alert.alert('Invalid', 'Roster size must be at least 1.')
            return
        }
        if (isNaN(parsedIR) || parsedIR < 0) {
            Alert.alert('Invalid', 'IR slots must be 0 or more.')
            return
        }
        if (isNaN(parsedTaxi) || parsedTaxi < 0) {
            Alert.alert('Invalid', 'Taxi squad slots must be 0 or more.')
            return
        }
        if (isNaN(parsedBudget) || parsedBudget < 1) {
            Alert.alert('Invalid', 'Auction budget must be at least 1.')
            return
        }
        if (isNaN(parsedPlayoff) || parsedPlayoff < 18 || parsedPlayoff > 26) {
            Alert.alert('Invalid', 'Playoff start week must be between 18 and 26.')
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
            Alert.alert('Invalid', 'Lineup slots can only be changed during league setup.')
            return
        }

        const scoringChanged = SCORING_FIELDS.some(({ key }) => scoring[key] !== initialScoring[key])
        const updates: {
            scoring_settings?: Record<string, number>
            roster_size?: number
            ir_slots?: number
            taxi_slots?: number
            auction_budget?: number
            playoff_start_week?: number
        } = {}
        if (scoringChanged) updates.scoring_settings = scoringSettings
        if (rosterSize !== initialGeneral.rosterSize) updates.roster_size = parsedRoster
        if (irSlots !== initialGeneral.irSlots) updates.ir_slots = parsedIR
        if (taxiSlots !== initialGeneral.taxiSlots) updates.taxi_slots = parsedTaxi
        if (auctionBudget !== initialGeneral.auctionBudget) updates.auction_budget = parsedBudget
        if (playoffWeek !== initialGeneral.playoffWeek) updates.playoff_start_week = parsedPlayoff

        setSaving(true)
        try {
            if (Object.keys(updates).length > 0) {
                await updateLeague(league.id, updates)
                setInitialScoring(scoring)
                setInitialGeneral({ rosterSize, irSlots, taxiSlots, auctionBudget, playoffWeek })
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
            Alert.alert('Error', getErrorMessage(e))
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
        Alert.alert(
            'Advance Season',
            'This will create a new season, carry rosters forward, and set the league to offseason. Continue?',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Advance',
                    style: 'destructive',
                    onPress: async () => {
                        setBusyAction('advance-season')
                        try {
                            await advanceSeason(league.id)
                            Alert.alert('Done', 'Season advanced. Start the rookie draft when ready.')
                            await refresh()
                        } catch (e) {
                            Alert.alert('Error', getErrorMessage(e))
                        } finally {
                            setBusyAction(null)
                        }
                    },
                },
            ],
        )
    }

    async function generateSchedule(force = false) {
        await adminCall(
            '/sync/matchups',
            force ? 'Schedule reset and regenerated.' : 'Schedule generated successfully.',
            'generate-schedule',
            setBusyAction,
            { force },
        )
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
                id: 'generate-schedule',
                label: 'Reset & Regenerate Schedule',
                color: colors.danger,
                onPress: () =>
                    Alert.alert(
                        'Reset Schedule',
                        'This will delete all existing matchups and regenerate. Are you sure?',
                        [
                            { text: 'Cancel', style: 'cancel' },
                            { text: 'Reset', style: 'destructive', onPress: () => generateSchedule(true) },
                        ],
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
        const busy = busyAction === action.id
        const color = action.color ?? colors.primary
        return (
            <Pressable
                key={`${action.id}:${action.label}`}
                style={[styles.actionButton, { borderColor: color }]}
                onPress={action.onPress}
                disabled={busyAction !== null}
            >
                {busy ? (
                    <ActivityIndicator color={color} />
                ) : (
                    <Text style={[styles.actionButtonText, { color }]}>{action.label}</Text>
                )}
            </Pressable>
        )
    }

    if (loading) {
        return <LoadingScreen />
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
                                label: 'Playoff Start Week (18–26)',
                                value: playoffWeek,
                                set: setPlayoffWeek,
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
                    </View>

                    {/* ── Save ──────────────────────────────────────── */}
                    <Pressable style={styles.saveButton} onPress={save} disabled={saving}>
                        {saving ? (
                            <ActivityIndicator color={colors.textWhite} />
                        ) : (
                            <Text style={styles.saveButtonText}>Save Settings</Text>
                        )}
                    </Pressable>

                    <Text style={styles.sectionTitle}>COMMISSIONER ACTIONS</Text>
                    {actionGroups[0].map(renderAction)}

                    <Text style={styles.sectionTitle}>ANNUAL CYCLE</Text>
                    {actionGroups[1].map(renderAction)}
                </ScrollView>
            </SafeAreaView>
        </>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgSubtle },
    scroll: { padding: spacing['2xl'], gap: spacing.md, paddingBottom: spacing['5xl'] },

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
        color: colors.primary,
        padding: 0,
    },

    stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
    stepBtn: {
        width: 30,
        height: 30,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        justifyContent: 'center',
        alignItems: 'center',
    },
    stepBtnText: { fontSize: 18, color: palette.gray900, lineHeight: 22 },
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
    actionButtonText: { color: colors.primary, fontWeight: fontWeight.bold, fontSize: fontSize.lg },
})
