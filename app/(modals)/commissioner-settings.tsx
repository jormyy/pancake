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
import { useEffect, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { getLineupSlots, updateLeague, updateLineupSlots } from '@/lib/league'
import { advanceSeason } from '@/lib/rookieDraft'
import { LoadingScreen } from '@/components/LoadingScreen'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'

// ── Scoring ───────────────────────────────────────────────────
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

// ── Lineup slots (excludes IR — managed via league.ir_slots) ──
const SLOT_TYPES = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE']

type SlotMap = Record<string, number>
type ScoringMap = Record<string, string> // string for TextInput, parsed on save

export default function CommissionerSettingsScreen() {
    const { current, refresh } = useLeagueContext()
    const { back } = useRouter()
    const league = current?.leagues as any

    const [scoring, setScoring] = useState<ScoringMap>({})
    const [slots, setSlots] = useState<SlotMap>({})
    const [rosterSize, setRosterSize] = useState('')
    const [irSlots, setIrSlots] = useState('')
    const [auctionBudget, setAuctionBudget] = useState('')
    const [playoffWeek, setPlayoffWeek] = useState('')
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [generatingSchedule, setGeneratingSchedule] = useState(false)
    const [syncingGames, setSyncingGames] = useState(false)
    const [syncingScores, setSyncingScores] = useState(false)
    const [syncingStats, setSyncingStats] = useState(false)
    const [processingWaivers, setProcessingWaivers] = useState(false)
    const [generatingPlayoffs, setGeneratingPlayoffs] = useState(false)
    const [advancingPlayoffs, setAdvancingPlayoffs] = useState(false)
    const [advancingSeason, setAdvancingSeason] = useState(false)
    const [syncingRankings, setSyncingRankings] = useState(false)
    const [syncingProjections, setSyncingProjections] = useState(false)

    useEffect(() => {
        async function load() {
            if (!league) return
            try {
                const slotData = await getLineupSlots(league.id)
                const slotMap: SlotMap = {}
                for (const s of slotData) slotMap[s.slot_type] = s.slot_count
                setSlots(slotMap)

                const s = league.scoring_settings ?? {}
                const scoreMap: ScoringMap = {}
                for (const { key } of SCORING_FIELDS) {
                    scoreMap[key] = s[key] != null ? String(s[key]) : '0'
                }
                setScoring(scoreMap)

                setRosterSize(String(league.roster_size ?? 20))
                setIrSlots(String(league.ir_slots ?? 2))
                setAuctionBudget(String(league.auction_budget ?? 200))
                setPlayoffWeek(String(league.playoff_start_week ?? 20))
            } catch (e) {
                console.error(e)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [])

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

        setSaving(true)
        try {
            await Promise.all([
                updateLeague(league.id, {
                    scoring_settings: scoringSettings,
                    roster_size: parsedRoster,
                    ir_slots: parsedIR,
                    auction_budget: parsedBudget,
                    playoff_start_week: parsedPlayoff,
                }),
                updateLineupSlots(
                    league.id,
                    SLOT_TYPES.map((t) => ({ slot_type: t, slot_count: slots[t] ?? 0 })),
                ),
            ])
            await refresh()
            back()
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setSaving(false)
        }
    }

    async function syncStats() {
        setSyncingStats(true)
        try {
            const res = await fetch(`${API_URL}/sync/stats`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ days: 7 }),
            })
            const json = await res.json()
            if (!json.ok) throw new Error(json.error || 'Failed to sync stats')
            Alert.alert('Done', 'Stats synced (last 7 days).')
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setSyncingStats(false)
        }
    }

    async function syncScores() {
        setSyncingScores(true)
        try {
            const res = await fetch(`${API_URL}/sync/scores`, { method: 'POST' })
            const json = await res.json()
            if (!json.ok) throw new Error(json.error || 'Failed to sync scores')
            Alert.alert('Done', 'Scores synced.')
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setSyncingScores(false)
        }
    }

    async function syncGameSchedule() {
        setSyncingGames(true)
        try {
            const res = await fetch(`${API_URL}/sync/schedule`, { method: 'POST' })
            const json = await res.json()
            if (!json.ok) throw new Error(json.error || 'Failed to sync games')
            Alert.alert('Done', 'Game schedule synced.')
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setSyncingGames(false)
        }
    }

    async function processWaivers() {
        setProcessingWaivers(true)
        try {
            const res = await fetch(`${API_URL}/waivers/process`, { method: 'POST' })
            const json = await res.json()
            if (!json.ok) throw new Error(json.error || 'Failed to process waivers')
            Alert.alert('Done', 'Waiver claims processed.')
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setProcessingWaivers(false)
        }
    }

    async function syncRankings() {
        setSyncingRankings(true)
        try {
            const res = await fetch(`${API_URL}/sync/rankings`, { method: 'POST' })
            const json = await res.json()
            if (!json.ok) throw new Error(json.error || 'Failed to sync rankings')
            Alert.alert('Done', 'Dynasty rankings synced.')
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setSyncingRankings(false)
        }
    }

    async function syncProjections() {
        setSyncingProjections(true)
        try {
            const res = await fetch(`${API_URL}/sync/projections`, { method: 'POST' })
            const json = await res.json()
            if (!json.ok) throw new Error(json.error || 'Failed to sync projections')
            Alert.alert('Done', 'Projections synced.')
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setSyncingProjections(false)
        }
    }

    async function generatePlayoffBracket() {
        if (!league?.id) return
        setGeneratingPlayoffs(true)
        try {
            const res = await fetch(`${API_URL}/playoffs/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leagueId: league.id }),
            })
            const json = await res.json()
            if (!json.ok) throw new Error(json.error || 'Failed to generate playoff bracket')
            Alert.alert('Done', 'Semifinal bracket generated.')
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setGeneratingPlayoffs(false)
        }
    }

    async function advancePlayoffBracket() {
        if (!league?.id) return
        setAdvancingPlayoffs(true)
        try {
            const res = await fetch(`${API_URL}/playoffs/advance`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leagueId: league.id }),
            })
            const json = await res.json()
            if (!json.ok) throw new Error(json.error || 'Failed to advance bracket')
            Alert.alert('Done', 'Championship matchup created.')
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setAdvancingPlayoffs(false)
        }
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
                        setAdvancingSeason(true)
                        try {
                            await advanceSeason(league.id)
                            Alert.alert('Done', 'Season advanced. Start the rookie draft when ready.')
                            await refresh()
                        } catch (e: any) {
                            Alert.alert('Error', e.message)
                        } finally {
                            setAdvancingSeason(false)
                        }
                    },
                },
            ],
        )
    }

    async function generateSchedule(force = false) {
        setGeneratingSchedule(true)
        try {
            const res = await fetch(`${API_URL}/sync/matchups`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ force }),
            })
            const json = await res.json()
            if (!json.ok) throw new Error(json.error || 'Failed to generate schedule')
            Alert.alert('Done', force ? 'Schedule reset and regenerated.' : 'Schedule generated successfully.')
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setGeneratingSchedule(false)
        }
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
                                    >
                                        <Text style={styles.stepBtnText}>−</Text>
                                    </Pressable>
                                    <Text style={styles.stepValue}>{slots[type] ?? 0}</Text>
                                    <Pressable
                                        style={styles.stepBtn}
                                        onPress={() => adjustSlot(type, 1)}
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

                    {/* ── Commissioner Actions ───────────────────────── */}
                    <Text style={styles.sectionTitle}>COMMISSIONER ACTIONS</Text>
                    <Pressable
                        style={styles.actionButton}
                        onPress={generatePlayoffBracket}
                        disabled={generatingPlayoffs}
                    >
                        {generatingPlayoffs ? (
                            <ActivityIndicator color={colors.primary} />
                        ) : (
                            <Text style={styles.actionButtonText}>Generate Playoff Bracket</Text>
                        )}
                    </Pressable>
                    <Pressable
                        style={styles.actionButton}
                        onPress={advancePlayoffBracket}
                        disabled={advancingPlayoffs}
                    >
                        {advancingPlayoffs ? (
                            <ActivityIndicator color={colors.primary} />
                        ) : (
                            <Text style={styles.actionButtonText}>Advance to Championship</Text>
                        )}
                    </Pressable>
                    <Pressable
                        style={styles.actionButton}
                        onPress={processWaivers}
                        disabled={processingWaivers}
                    >
                        {processingWaivers ? (
                            <ActivityIndicator color={colors.primary} />
                        ) : (
                            <Text style={styles.actionButtonText}>Process Waiver Claims</Text>
                        )}
                    </Pressable>
                    <Pressable
                        style={styles.actionButton}
                        onPress={syncStats}
                        disabled={syncingStats}
                    >
                        {syncingStats ? (
                            <ActivityIndicator color={colors.primary} />
                        ) : (
                            <Text style={styles.actionButtonText}>Sync Player Stats</Text>
                        )}
                    </Pressable>
                    <Pressable
                        style={styles.actionButton}
                        onPress={syncScores}
                        disabled={syncingScores}
                    >
                        {syncingScores ? (
                            <ActivityIndicator color={colors.primary} />
                        ) : (
                            <Text style={styles.actionButtonText}>Sync Scores Now</Text>
                        )}
                    </Pressable>
                    <Pressable
                        style={styles.actionButton}
                        onPress={syncRankings}
                        disabled={syncingRankings}
                    >
                        {syncingRankings ? (
                            <ActivityIndicator color={colors.primary} />
                        ) : (
                            <Text style={styles.actionButtonText}>Sync Dynasty Rankings</Text>
                        )}
                    </Pressable>
                    <Pressable
                        style={styles.actionButton}
                        onPress={syncProjections}
                        disabled={syncingProjections}
                    >
                        {syncingProjections ? (
                            <ActivityIndicator color={colors.primary} />
                        ) : (
                            <Text style={styles.actionButtonText}>Sync Projections</Text>
                        )}
                    </Pressable>
                    <Pressable
                        style={styles.actionButton}
                        onPress={syncGameSchedule}
                        disabled={syncingGames}
                    >
                        {syncingGames ? (
                            <ActivityIndicator color={colors.primary} />
                        ) : (
                            <Text style={styles.actionButtonText}>Sync NBA Game Schedule</Text>
                        )}
                    </Pressable>
                    <Pressable
                        style={styles.actionButton}
                        onPress={() => generateSchedule(false)}
                        disabled={generatingSchedule}
                    >
                        {generatingSchedule ? (
                            <ActivityIndicator color={colors.primary} />
                        ) : (
                            <Text style={styles.actionButtonText}>Generate Season Schedule</Text>
                        )}
                    </Pressable>
                    <Pressable
                        style={[styles.actionButton, { borderColor: colors.danger }]}
                        onPress={() =>
                            Alert.alert(
                                'Reset Schedule',
                                'This will delete all existing matchups and regenerate. Are you sure?',
                                [
                                    { text: 'Cancel', style: 'cancel' },
                                    { text: 'Reset', style: 'destructive', onPress: () => generateSchedule(true) },
                                ],
                            )
                        }
                        disabled={generatingSchedule}
                    >
                        <Text style={[styles.actionButtonText, { color: colors.danger }]}>
                            Reset &amp; Regenerate Schedule
                        </Text>
                    </Pressable>

                    {/* ── Annual Cycle ───────────────────────────── */}
                    <Text style={styles.sectionTitle}>ANNUAL CYCLE</Text>
                    <Pressable
                        style={[styles.actionButton, { borderColor: colors.info }]}
                        onPress={handleAdvanceSeason}
                        disabled={advancingSeason}
                    >
                        {advancingSeason ? (
                            <ActivityIndicator color={colors.info} />
                        ) : (
                            <Text style={[styles.actionButtonText, { color: colors.info }]}>
                                Advance to Next Season
                            </Text>
                        )}
                    </Pressable>
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
