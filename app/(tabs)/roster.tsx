import {
    View,
    Text,
    FlatList,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { useEffect, useState, useCallback } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { getRoster, toggleIR, RosterPlayer } from '@/lib/roster'

const POSITION_COLORS: Record<string, string> = {
    PG: '#3B82F6',
    SG: '#8B5CF6',
    SF: '#10B981',
    PF: '#F59E0B',
    C: '#EF4444',
    G: '#6366F1',
    F: '#14B8A6',
}

const INJURY_COLORS: Record<string, string> = {
    Questionable: '#F59E0B',
    Doubtful: '#F97316',
    Out: '#EF4444',
    IR: '#7F1D1D',
}

export default function RosterScreen() {
    const { user } = useAuth()
    const { current, loading: leagueLoading } = useLeagueContext()
    const [roster, setRoster] = useState<RosterPlayer[]>([])
    const [loading, setLoading] = useState(true)
    const [togglingId, setTogglingId] = useState<string | null>(null)

    const load = useCallback(async () => {
        if (!current || !user) return
        setLoading(true)
        try {
            const data = await getRoster(current.id, (current.leagues as any).id)
            setRoster(data)
        } catch (e) {
            console.error(e)
        } finally {
            setLoading(false)
        }
    }, [current, user])

    useFocusEffect(
        useCallback(() => {
            load()
        }, [load]),
    )

    async function handleToggleIR(item: RosterPlayer) {
        const league = current?.leagues as any
        const irSlots = league?.ir_slots ?? 2
        const activeSlots = league?.roster_size ?? 20

        if (!item.is_on_ir) {
            // Moving to IR — check IR slot availability
            const currentIR = roster.filter((p) => p.is_on_ir).length
            if (currentIR >= irSlots) {
                Alert.alert('IR Full', `You only have ${irSlots} IR slot${irSlots > 1 ? 's' : ''}.`)
                return
            }
        } else {
            // Moving off IR — check active roster has room
            const activeCount = roster.filter((p) => !p.is_on_ir).length
            if (activeCount >= activeSlots) {
                Alert.alert('Roster Full', `Your active roster is full (${activeSlots} players).`)
                return
            }
        }

        setTogglingId(item.id)
        try {
            await toggleIR(item.id, !item.is_on_ir)
            await load()
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setTogglingId(null)
        }
    }

    if (leagueLoading || (!current && loading)) {
        return (
            <SafeAreaView style={styles.container}>
                <ActivityIndicator style={{ flex: 1 }} color="#F97316" />
            </SafeAreaView>
        )
    }

    if (!current) {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.empty}>
                    <Text style={styles.emptyText}>Join or create a league first.</Text>
                </View>
            </SafeAreaView>
        )
    }

    const league = current.leagues as any
    const active = roster.filter((p) => !p.is_on_ir)
    const ir = roster.filter((p) => p.is_on_ir)

    return (
        <SafeAreaView style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <View style={{ flex: 1 }}>
                    <Text style={styles.leagueName}>{league?.name}</Text>
                    <Text style={styles.teamName}>{current.team_name}</Text>
                    <Text style={styles.rosterCount}>
                        {active.length}/{league?.roster_size ?? 20} active · {ir.length}/
                        {league?.ir_slots ?? 2} IR
                    </Text>
                </View>
                <TouchableOpacity
                    style={styles.lineupButton}
                    onPress={() => router.push('/(modals)/lineup')}
                >
                    <Text style={styles.lineupButtonText}>Set Lineup</Text>
                </TouchableOpacity>
            </View>

            {loading ? (
                <ActivityIndicator style={{ flex: 1 }} color="#F97316" />
            ) : roster.length === 0 ? (
                <View style={styles.empty}>
                    <Text style={styles.emptyTitle}>Your roster is empty</Text>
                    <Text style={styles.emptyText}>Players will appear here after the draft.</Text>
                </View>
            ) : (
                <FlatList
                    data={[
                        ...active.map((p) => ({ ...p, _section: 'active' })),
                        ...(ir.length > 0 ? [{ _isHeader: true, _section: 'ir' } as any] : []),
                        ...ir.map((p) => ({ ...p, _section: 'ir' })),
                    ]}
                    keyExtractor={(item) => (item._isHeader ? 'ir-header' : item.id)}
                    ItemSeparatorComponent={() => <View style={styles.separator} />}
                    renderItem={({ item }) => {
                        if (item._isHeader) {
                            return (
                                <View style={styles.sectionHeader}>
                                    <Text style={styles.sectionHeaderText}>IR</Text>
                                </View>
                            )
                        }
                        const player = item.players
                        const pos = player.position ?? ''
                        return (
                            <TouchableOpacity
                                style={styles.playerRow}
                                onPress={() => router.push(`/player/${player.id}`)}
                                activeOpacity={0.7}
                            >
                                <View
                                    style={[
                                        styles.avatar,
                                        { backgroundColor: POSITION_COLORS[pos] ?? '#ccc' },
                                    ]}
                                >
                                    <Text style={styles.avatarText}>
                                        {player.display_name
                                            .split(' ')
                                            .map((w: string) => w[0])
                                            .slice(0, 2)
                                            .join('')}
                                    </Text>
                                </View>

                                <View style={styles.info}>
                                    <Text style={styles.playerName}>{player.display_name}</Text>
                                    <Text style={styles.playerMeta}>
                                        {[player.nba_team, pos].filter(Boolean).join(' · ')}
                                    </Text>
                                    {player.injury_status && (
                                        <View
                                            style={[
                                                styles.injuryBadge,
                                                {
                                                    backgroundColor:
                                                        INJURY_COLORS[player.injury_status] ??
                                                        '#888',
                                                },
                                            ]}
                                        >
                                            <Text style={styles.injuryText}>
                                                {player.injury_status}
                                            </Text>
                                        </View>
                                    )}
                                </View>

                                <TouchableOpacity
                                    style={[
                                        styles.irButton,
                                        item.is_on_ir && styles.irButtonActive,
                                    ]}
                                    onPress={() => handleToggleIR(item)}
                                    disabled={togglingId === item.id}
                                >
                                    {togglingId === item.id ? (
                                        <ActivityIndicator
                                            size="small"
                                            color={item.is_on_ir ? '#fff' : '#888'}
                                        />
                                    ) : (
                                        <Text
                                            style={[
                                                styles.irButtonText,
                                                item.is_on_ir && styles.irButtonTextActive,
                                            ]}
                                        >
                                            {item.is_on_ir ? 'Active' : 'IR'}
                                        </Text>
                                    )}
                                </TouchableOpacity>
                            </TouchableOpacity>
                        )
                    }}
                />
            )}
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#fff' },

    header: {
        padding: 20,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
        gap: 2,
        flexDirection: 'row',
        alignItems: 'center',
    },
    lineupButton: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        backgroundColor: '#F97316',
        borderRadius: 10,
        marginLeft: 12,
    },
    lineupButtonText: { color: '#fff', fontWeight: '700', fontSize: 13 },
    leagueName: { fontSize: 18, fontWeight: '800' },
    teamName: { fontSize: 14, color: '#555' },
    rosterCount: { fontSize: 12, color: '#aaa', marginTop: 4 },

    sectionHeader: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#f9f9f9' },
    sectionHeaderText: { fontSize: 12, fontWeight: '700', color: '#888', letterSpacing: 1 },

    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 12,
    },
    separator: { height: 1, backgroundColor: '#f3f3f3', marginLeft: 72 },

    avatar: {
        width: 44,
        height: 44,
        borderRadius: 22,
        justifyContent: 'center',
        alignItems: 'center',
    },
    avatarText: { color: '#fff', fontWeight: '700', fontSize: 14 },

    info: { flex: 1, gap: 2 },
    playerName: { fontSize: 16, fontWeight: '600' },
    playerMeta: { fontSize: 13, color: '#888' },
    injuryBadge: {
        alignSelf: 'flex-start',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
        marginTop: 2,
    },
    injuryText: { color: '#fff', fontSize: 10, fontWeight: '700' },

    irButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#ddd',
        minWidth: 52,
        alignItems: 'center',
    },
    irButtonActive: { backgroundColor: '#EF4444', borderColor: '#EF4444' },
    irButtonText: { fontSize: 12, fontWeight: '700', color: '#888' },
    irButtonTextActive: { color: '#fff' },

    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8 },
    emptyTitle: { fontSize: 18, fontWeight: '700' },
    emptyText: { fontSize: 14, color: '#aaa' },
})
