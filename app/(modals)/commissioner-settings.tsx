import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    ScrollView,
    StyleSheet,
    ActivityIndicator,
    Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, router } from 'expo-router'
import { useEffect, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { getLineupSlots, updateLeague, updateLineupSlots } from '@/lib/league'

// ── Scoring ───────────────────────────────────────────────────
const SCORING_FIELDS: { key: string; label: string }[] = [
    { key: 'points', label: 'Points' },
    { key: 'rebounds', label: 'Rebounds' },
    { key: 'assists', label: 'Assists' },
    { key: 'steals', label: 'Steals' },
    { key: 'blocks', label: 'Blocks' },
    { key: 'turnovers', label: 'Turnovers' },
    { key: 'three_pointers_made', label: '3-Pointers Made' },
    { key: 'double_double', label: 'Double-Double Bonus' },
    { key: 'triple_double', label: 'Triple-Double Bonus' },
]

// ── Lineup slots (excludes IR — managed via league.ir_slots) ──
const SLOT_TYPES = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL', 'BE']

type SlotMap = Record<string, number>
type ScoringMap = Record<string, string> // string for TextInput, parsed on save

export default function CommissionerSettingsScreen() {
    const { current, refresh } = useLeagueContext()
    const league = current?.leagues as any

    const [scoring, setScoring] = useState<ScoringMap>({})
    const [slots, setSlots] = useState<SlotMap>({})
    const [rosterSize, setRosterSize] = useState('')
    const [irSlots, setIrSlots] = useState('')
    const [auctionBudget, setAuctionBudget] = useState('')
    const [playoffWeek, setPlayoffWeek] = useState('')
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)

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
        if (isNaN(parsedPlayoff) || parsedPlayoff < 18 || parsedPlayoff > 22) {
            Alert.alert('Invalid', 'Playoff start week must be between 18 and 22.')
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
            router.back()
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setSaving(false)
        }
    }

    if (loading) {
        return (
            <SafeAreaView style={styles.container}>
                <ActivityIndicator style={{ flex: 1 }} color="#F97316" />
            </SafeAreaView>
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
                                    onChangeText={(v) =>
                                        setScoring((prev) => ({ ...prev, [key]: v }))
                                    }
                                    keyboardType="numeric"
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
                                    <TouchableOpacity
                                        style={styles.stepBtn}
                                        onPress={() => adjustSlot(type, -1)}
                                    >
                                        <Text style={styles.stepBtnText}>−</Text>
                                    </TouchableOpacity>
                                    <Text style={styles.stepValue}>{slots[type] ?? 0}</Text>
                                    <TouchableOpacity
                                        style={styles.stepBtn}
                                        onPress={() => adjustSlot(type, 1)}
                                    >
                                        <Text style={styles.stepBtnText}>+</Text>
                                    </TouchableOpacity>
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
                                label: 'Playoff Start Week (18–22)',
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
                    <TouchableOpacity style={styles.saveButton} onPress={save} disabled={saving}>
                        {saving ? (
                            <ActivityIndicator color="#fff" />
                        ) : (
                            <Text style={styles.saveButtonText}>Save Settings</Text>
                        )}
                    </TouchableOpacity>
                </ScrollView>
            </SafeAreaView>
        </>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },
    scroll: { padding: 20, gap: 8, paddingBottom: 40 },

    sectionTitle: {
        fontSize: 11,
        fontWeight: '700',
        color: '#aaa',
        letterSpacing: 0.8,
        marginTop: 12,
        marginBottom: 4,
        marginLeft: 4,
    },

    card: {
        backgroundColor: '#fff',
        borderRadius: 14,
        borderWidth: 1,
        borderColor: '#eee',
        overflow: 'hidden',
    },
    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
    rowBorder: { borderBottomWidth: 1, borderBottomColor: '#f3f3f3' },
    rowLabel: { flex: 1, fontSize: 15, color: '#111' },

    scoreInput: {
        width: 72,
        textAlign: 'right',
        fontSize: 15,
        fontWeight: '600',
        color: '#F97316',
        padding: 0,
    },

    stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    stepBtn: {
        width: 30,
        height: 30,
        borderRadius: 8,
        backgroundColor: '#f3f3f3',
        justifyContent: 'center',
        alignItems: 'center',
    },
    stepBtnText: { fontSize: 18, color: '#333', lineHeight: 22 },
    stepValue: {
        fontSize: 16,
        fontWeight: '700',
        color: '#111',
        minWidth: 20,
        textAlign: 'center',
    },

    saveButton: {
        marginTop: 16,
        backgroundColor: '#F97316',
        borderRadius: 14,
        height: 52,
        justifyContent: 'center',
        alignItems: 'center',
    },
    saveButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
})
