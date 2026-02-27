import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    FlatList,
    StyleSheet,
    ActivityIndicator,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { useState, useEffect, useCallback } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { searchPlayers, PlayerRow } from '@/lib/players'
import { getOwnedPlayerIds } from '@/lib/roster'
import { useLeagueContext } from '@/contexts/league-context'

const POSITIONS = ['ALL', 'PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']

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

export default function PlayersScreen() {
    const { current } = useLeagueContext()
    const [query, setQuery] = useState('')
    const [position, setPosition] = useState('ALL')
    const [players, setPlayers] = useState<PlayerRow[]>([])
    const [loading, setLoading] = useState(true)
    const [ownedIds, setOwnedIds] = useState<Set<string>>(new Set())

    const loadOwned = useCallback(async () => {
        if (!current) return
        const league = current.leagues as any
        try {
            const ids = await getOwnedPlayerIds(league.id)
            setOwnedIds(ids)
        } catch (e) {
            console.error(e)
        }
    }, [current])

    useFocusEffect(
        useCallback(() => {
            loadOwned()
        }, [loadOwned]),
    )

    const load = useCallback(async (q: string, pos: string) => {
        setLoading(true)
        try {
            const results = await searchPlayers(q, pos)
            setPlayers(results)
        } catch (e) {
            console.error(e)
        } finally {
            setLoading(false)
        }
    }, [])

    // Debounced search
    useEffect(() => {
        const timer = setTimeout(() => load(query, position), 300)
        return () => clearTimeout(timer)
    }, [query, position, load])

    return (
        <SafeAreaView style={styles.container}>
            {/* Search bar */}
            <View style={styles.searchRow}>
                <TextInput
                    style={styles.searchInput}
                    placeholder="Search players..."
                    placeholderTextColor="#aaa"
                    value={query}
                    onChangeText={setQuery}
                    autoCorrect={false}
                    clearButtonMode="while-editing"
                />
            </View>

            {/* Position filter */}
            <FlatList
                data={POSITIONS}
                horizontal
                showsHorizontalScrollIndicator={false}
                keyExtractor={(p) => p}
                contentContainerStyle={styles.positionRow}
                renderItem={({ item }) => (
                    <TouchableOpacity
                        style={[styles.posChip, position === item && styles.posChipActive]}
                        onPress={() => setPosition(item)}
                    >
                        <Text
                            style={[
                                styles.posChipText,
                                position === item && styles.posChipTextActive,
                            ]}
                        >
                            {item}
                        </Text>
                    </TouchableOpacity>
                )}
            />

            {/* Results */}
            {loading ? (
                <ActivityIndicator style={{ flex: 1 }} color="#F97316" />
            ) : (
                <FlatList
                    data={players}
                    keyExtractor={(p) => p.id}
                    contentContainerStyle={players.length === 0 && styles.emptyContainer}
                    ItemSeparatorComponent={() => <View style={styles.separator} />}
                    renderItem={({ item }) => (
                        <TouchableOpacity
                            style={styles.playerRow}
                            onPress={() => router.push(`/player/${item.id}`)}
                            activeOpacity={0.7}
                        >
                            {/* Avatar */}
                            <View
                                style={[
                                    styles.avatar,
                                    {
                                        backgroundColor:
                                            POSITION_COLORS[item.position ?? ''] ?? '#ccc',
                                    },
                                ]}
                            >
                                <Text style={styles.avatarText}>
                                    {item.display_name
                                        .split(' ')
                                        .map((w) => w[0])
                                        .slice(0, 2)
                                        .join('')}
                                </Text>
                            </View>

                            {/* Info */}
                            <View style={styles.playerInfo}>
                                <Text style={styles.playerName}>{item.display_name}</Text>
                                <Text style={styles.playerMeta}>
                                    {[item.nba_team, item.position].filter(Boolean).join(' · ')}
                                </Text>
                            </View>

                            {/* Injury badge */}
                            {item.injury_status && (
                                <View
                                    style={[
                                        styles.injuryBadge,
                                        {
                                            backgroundColor:
                                                INJURY_COLORS[item.injury_status] ?? '#888',
                                        },
                                    ]}
                                >
                                    <Text style={styles.injuryText}>{item.injury_status}</Text>
                                </View>
                            )}

                            {/* Owned badge */}
                            {current && (
                                <View
                                    style={[
                                        styles.ownedBadge,
                                        ownedIds.has(item.id) && styles.ownedBadgeOwned,
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.ownedBadgeText,
                                            ownedIds.has(item.id) && styles.ownedBadgeTextOwned,
                                        ]}
                                    >
                                        {ownedIds.has(item.id) ? 'Owned' : 'FA'}
                                    </Text>
                                </View>
                            )}
                        </TouchableOpacity>
                    )}
                    ListEmptyComponent={<Text style={styles.emptyText}>No players found.</Text>}
                />
            )}
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#fff' },

    searchRow: { paddingHorizontal: 16, paddingVertical: 10 },
    searchInput: {
        height: 44,
        backgroundColor: '#f3f3f3',
        borderRadius: 10,
        paddingHorizontal: 14,
        fontSize: 16,
    },

    positionRow: { paddingHorizontal: 16, paddingBottom: 10, gap: 8 },
    posChip: {
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: 20,
        backgroundColor: '#f3f3f3',
    },
    posChipActive: { backgroundColor: '#F97316' },
    posChipText: { fontSize: 13, fontWeight: '600', color: '#555' },
    posChipTextActive: { color: '#fff' },

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

    playerInfo: { flex: 1 },
    playerName: { fontSize: 16, fontWeight: '600' },
    playerMeta: { fontSize: 13, color: '#888', marginTop: 2 },

    injuryBadge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
    },
    injuryText: { color: '#fff', fontSize: 11, fontWeight: '700' },

    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    emptyText: { color: '#aaa', fontSize: 15 },

    ownedBadge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: '#f0f0f0',
    },
    ownedBadgeOwned: { backgroundColor: '#FEE2E2' },
    ownedBadgeText: { fontSize: 11, fontWeight: '700', color: '#aaa' },
    ownedBadgeTextOwned: { color: '#DC2626' },
})
