import {
    View,
    Text,
    TouchableOpacity,
    FlatList,
    StyleSheet,
    ActivityIndicator,
    Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { getRoster, RosterPlayer } from '@/lib/roster'
import { getPlayer } from '@/lib/players'
import { submitWaiverClaim, getMyWaiverPriority } from '@/lib/waivers'

export default function ClaimPlayerScreen() {
    const { playerId } = useLocalSearchParams<{ playerId: string }>()
    const { current } = useLeagueContext()
    const { user } = useAuth()

    const [player, setPlayer] = useState<any>(null)
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>([])
    const [priority, setPriority] = useState<number | null>(null)
    const [loading, setLoading] = useState(true)
    const [selectedDrop, setSelectedDrop] = useState<RosterPlayer | null>(null)
    const [submitting, setSubmitting] = useState(false)

    const league = current?.leagues as any
    const rosterSize = league?.roster_size ?? 20

    useEffect(() => {
        async function load() {
            if (!current || !user || !playerId) return
            try {
                const [p, roster, prio] = await Promise.all([
                    getPlayer(playerId),
                    getRoster(current.id, league.id),
                    getMyWaiverPriority(current.id, league.id),
                ])
                setPlayer(p)
                setMyRoster(roster)
                setPriority(prio)
            } catch (e) {
                console.error(e)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [playerId, current, user])

    const activeRoster = myRoster.filter((p) => !p.is_on_ir)
    const rosterFull = activeRoster.length >= rosterSize
    const needsDrop = rosterFull

    async function handleSubmit() {
        if (!current || !user || !playerId) return
        if (needsDrop && !selectedDrop) {
            Alert.alert('Select Drop', 'Your roster is full. Select a player to drop.')
            return
        }

        setSubmitting(true)
        try {
            await submitWaiverClaim(
                current.id,
                league.id,
                playerId,
                selectedDrop?.players.id,
            )
            Alert.alert(
                'Claim Submitted',
                'Your waiver claim has been submitted. Claims are processed nightly.',
                [{ text: 'OK', onPress: () => router.back() }],
            )
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setSubmitting(false)
        }
    }

    if (loading) {
        return (
            <SafeAreaView style={styles.container}>
                <ActivityIndicator style={{ flex: 1 }} color="#F97316" />
            </SafeAreaView>
        )
    }

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const processDateStr = tomorrow.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
    })

    return (
        <>
            <Stack.Screen options={{ title: 'Waiver Claim', presentation: 'modal' }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                {/* Player being claimed */}
                <View style={styles.claimCard}>
                    <Text style={styles.claimLabel}>CLAIMING</Text>
                    <Text style={styles.claimName}>{player?.display_name ?? '—'}</Text>
                    <Text style={styles.claimMeta}>
                        {[player?.nba_team, player?.position].filter(Boolean).join(' · ')}
                    </Text>
                </View>

                <View style={styles.infoRow}>
                    <View style={styles.infoCell}>
                        <Text style={styles.infoLabel}>Your Priority</Text>
                        <Text style={styles.infoValue}>#{priority ?? '—'}</Text>
                    </View>
                    <View style={styles.infoCell}>
                        <Text style={styles.infoLabel}>Process Date</Text>
                        <Text style={styles.infoValue}>{processDateStr}</Text>
                    </View>
                </View>

                {needsDrop ? (
                    <>
                        <Text style={styles.sectionTitle}>DROP A PLAYER (required)</Text>
                        <Text style={styles.sectionSub}>Your roster is full. Select one player to drop if this claim succeeds.</Text>
                        <FlatList
                            data={activeRoster}
                            keyExtractor={(item) => item.id}
                            contentContainerStyle={styles.rosterList}
                            renderItem={({ item }) => {
                                const isSelected = selectedDrop?.id === item.id
                                return (
                                    <TouchableOpacity
                                        style={[styles.rosterRow, isSelected && styles.rosterRowSelected]}
                                        onPress={() => setSelectedDrop(isSelected ? null : item)}
                                        activeOpacity={0.7}
                                    >
                                        <View style={styles.rosterInfo}>
                                            <Text style={styles.rosterName}>{item.players.display_name}</Text>
                                            <Text style={styles.rosterMeta}>
                                                {[item.players.nba_team, item.players.position]
                                                    .filter(Boolean)
                                                    .join(' · ')}
                                            </Text>
                                        </View>
                                        <View style={[styles.check, isSelected && styles.checkSelected]}>
                                            {isSelected && <Text style={styles.checkText}>✓</Text>}
                                        </View>
                                    </TouchableOpacity>
                                )
                            }}
                        />
                    </>
                ) : (
                    <View style={styles.spaceNote}>
                        <Text style={styles.spaceNoteText}>
                            You have roster space. No drop required.
                        </Text>
                    </View>
                )}

                <View style={styles.footer}>
                    <TouchableOpacity
                        style={[styles.submitButton, (needsDrop && !selectedDrop) && styles.submitButtonDisabled]}
                        onPress={handleSubmit}
                        disabled={submitting || (needsDrop && !selectedDrop)}
                    >
                        {submitting ? (
                            <ActivityIndicator color="#fff" />
                        ) : (
                            <Text style={styles.submitButtonText}>Submit Claim</Text>
                        )}
                    </TouchableOpacity>
                </View>
            </SafeAreaView>
        </>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#f5f5f5' },

    claimCard: {
        margin: 16,
        padding: 20,
        backgroundColor: '#fff',
        borderRadius: 14,
        borderWidth: 1,
        borderColor: '#eee',
        gap: 4,
    },
    claimLabel: { fontSize: 11, fontWeight: '700', color: '#8B5CF6', letterSpacing: 1 },
    claimName: { fontSize: 22, fontWeight: '800', color: '#111' },
    claimMeta: { fontSize: 14, color: '#888' },

    infoRow: {
        flexDirection: 'row',
        marginHorizontal: 16,
        marginBottom: 16,
        gap: 12,
    },
    infoCell: {
        flex: 1,
        backgroundColor: '#fff',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#eee',
        padding: 14,
        alignItems: 'center',
        gap: 4,
    },
    infoLabel: { fontSize: 11, fontWeight: '700', color: '#aaa', letterSpacing: 0.5 },
    infoValue: { fontSize: 18, fontWeight: '800', color: '#111' },

    sectionTitle: {
        fontSize: 11,
        fontWeight: '700',
        color: '#aaa',
        letterSpacing: 0.8,
        marginHorizontal: 20,
        marginBottom: 4,
    },
    sectionSub: {
        fontSize: 13,
        color: '#888',
        marginHorizontal: 20,
        marginBottom: 12,
    },

    rosterList: { paddingHorizontal: 16, gap: 8 },
    rosterRow: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#fff',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#eee',
        padding: 14,
        gap: 12,
    },
    rosterRowSelected: { borderColor: '#EF4444', backgroundColor: '#FEF2F2' },
    rosterInfo: { flex: 1, gap: 2 },
    rosterName: { fontSize: 15, fontWeight: '600', color: '#111' },
    rosterMeta: { fontSize: 13, color: '#888' },
    check: {
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: 1.5,
        borderColor: '#ddd',
        justifyContent: 'center',
        alignItems: 'center',
    },
    checkSelected: { backgroundColor: '#EF4444', borderColor: '#EF4444' },
    checkText: { color: '#fff', fontSize: 13, fontWeight: '700' },

    spaceNote: {
        margin: 16,
        padding: 16,
        backgroundColor: '#F0FDF4',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#BBF7D0',
    },
    spaceNoteText: { fontSize: 14, color: '#166534', fontWeight: '600', textAlign: 'center' },

    footer: { padding: 16, paddingBottom: 8 },
    submitButton: {
        backgroundColor: '#8B5CF6',
        borderRadius: 14,
        height: 52,
        justifyContent: 'center',
        alignItems: 'center',
    },
    submitButtonDisabled: { backgroundColor: '#C4B5FD' },
    submitButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
})
