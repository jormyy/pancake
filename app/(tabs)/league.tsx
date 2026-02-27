import {
    View,
    Text,
    FlatList,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    Share,
    Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { useCallback, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { getLeagueMembers } from '@/lib/league'
import { getLeagueStandings, StandingRow } from '@/lib/scoring'
import { getActiveDraft, startDraft } from '@/lib/draft'

const ROLE_LABELS: Record<string, string> = {
    commissioner: 'Commissioner',
    co_commissioner: 'Co-Comm',
    manager: 'Manager',
}

type Tab = 'members' | 'standings'

export default function LeagueScreen() {
    const { current, loading: leagueLoading } = useLeagueContext()
    const { user } = useAuth()
    const [tab, setTab] = useState<Tab>('standings')
    const [members, setMembers] = useState<any[]>([])
    const [standings, setStandings] = useState<StandingRow[]>([])
    const [loading, setLoading] = useState(true)
    const [draftLoading, setDraftLoading] = useState(false)

    const league = current?.leagues as any
    const isCommissioner = league?.commissioner_id === user?.id

    const load = useCallback(async () => {
        if (!current) return
        setLoading(true)
        try {
            const [memberData, standingsData] = await Promise.all([
                getLeagueMembers(league.id),
                getLeagueStandings(league.id),
            ])
            setMembers(memberData)
            setStandings(standingsData)
        } catch (e) {
            console.error(e)
        } finally {
            setLoading(false)
        }
    }, [current])

    useFocusEffect(
        useCallback(() => {
            load()
        }, [load]),
    )

    async function handleStartDraft() {
        if (!league?.id) return
        setDraftLoading(true)
        try {
            const draft = await startDraft(league.id)
            router.push({ pathname: '/(modals)/draft-room', params: { draftId: draft.id } })
        } catch (e: any) {
            Alert.alert('Could not start draft', e.message)
        } finally {
            setDraftLoading(false)
        }
    }

    async function handleJoinDraftRoom() {
        if (!league?.id) return
        setDraftLoading(true)
        try {
            const draft = await getActiveDraft(league.id)
            if (!draft) {
                Alert.alert('No active draft found')
                return
            }
            router.push({ pathname: '/(modals)/draft-room', params: { draftId: draft.id } })
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setDraftLoading(false)
        }
    }

    async function shareInviteCode() {
        await Share.share({
            message: `Join my Pancake league! Use invite code: ${league?.invite_code}`,
        })
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

    return (
        <SafeAreaView style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.headerTop}>
                    <View style={styles.headerInfo}>
                        <Text style={styles.leagueName}>{league?.name}</Text>
                        <Text style={styles.teamName}>{current.team_name}</Text>
                    </View>
                    {isCommissioner && (
                        <TouchableOpacity
                            style={styles.settingsButton}
                            onPress={() => router.push('/(modals)/commissioner-settings')}
                        >
                            <Text style={styles.settingsButtonText}>⚙ Settings</Text>
                        </TouchableOpacity>
                    )}
                </View>

                {/* Invite code */}
                <TouchableOpacity
                    style={styles.inviteRow}
                    onPress={shareInviteCode}
                    activeOpacity={0.7}
                >
                    <Text style={styles.inviteLabel}>Invite Code</Text>
                    <Text style={styles.inviteCode}>{league?.invite_code}</Text>
                    <Text style={styles.inviteCopy}>Share</Text>
                </TouchableOpacity>

                {/* Draft actions */}
                {league?.status === 'setup' && isCommissioner && (
                    <TouchableOpacity
                        style={styles.draftButton}
                        onPress={handleStartDraft}
                        disabled={draftLoading}
                    >
                        {draftLoading ? (
                            <ActivityIndicator size="small" color="#fff" />
                        ) : (
                            <Text style={styles.draftButtonText}>Start Auction Draft</Text>
                        )}
                    </TouchableOpacity>
                )}
                {league?.status === 'drafting' && (
                    <TouchableOpacity
                        style={styles.draftButton}
                        onPress={handleJoinDraftRoom}
                        disabled={draftLoading}
                    >
                        {draftLoading ? (
                            <ActivityIndicator size="small" color="#fff" />
                        ) : (
                            <Text style={styles.draftButtonText}>Join Draft Room</Text>
                        )}
                    </TouchableOpacity>
                )}
            </View>

            {/* Tab switcher */}
            <View style={styles.tabRow}>
                {(['standings', 'members'] as Tab[]).map((t) => (
                    <TouchableOpacity
                        key={t}
                        style={[styles.tabChip, tab === t && styles.tabChipActive]}
                        onPress={() => setTab(t)}
                    >
                        <Text style={[styles.tabChipText, tab === t && styles.tabChipTextActive]}>
                            {t === 'standings' ? 'Standings' : `Teams (${members.length})`}
                        </Text>
                    </TouchableOpacity>
                ))}
            </View>

            {loading ? (
                <ActivityIndicator style={{ marginTop: 24 }} color="#F97316" />
            ) : tab === 'standings' ? (
                <StandingsTable standings={standings} myMemberId={current?.id} />
            ) : (
                <FlatList
                    data={members}
                    keyExtractor={(m) => m.id}
                    ItemSeparatorComponent={() => <View style={styles.separator} />}
                    renderItem={({ item }) => {
                        const profile = item.profiles as any
                        const isMe = item.user_id === user?.id
                        return (
                            <View style={styles.memberRow}>
                                <View style={styles.memberAvatar}>
                                    <Text style={styles.memberAvatarText}>
                                        {(item.team_name ??
                                            profile?.display_name ??
                                            '?')[0].toUpperCase()}
                                    </Text>
                                </View>
                                <View style={styles.memberInfo}>
                                    <Text style={styles.memberTeam}>
                                        {item.team_name ?? 'Unnamed Team'}
                                        {isMe && <Text style={styles.meTag}> (you)</Text>}
                                    </Text>
                                    <Text style={styles.memberName}>
                                        {profile?.display_name ?? profile?.username}
                                    </Text>
                                </View>
                                <View
                                    style={[
                                        styles.roleBadge,
                                        item.role === 'commissioner' &&
                                            styles.roleBadgeCommissioner,
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.roleText,
                                            item.role === 'commissioner' &&
                                                styles.roleTextCommissioner,
                                        ]}
                                    >
                                        {ROLE_LABELS[item.role] ?? item.role}
                                    </Text>
                                </View>
                            </View>
                        )
                    }}
                />
            )}
        </SafeAreaView>
    )
}

function StandingsTable({
    standings,
    myMemberId,
}: {
    standings: StandingRow[]
    myMemberId?: string
}) {
    if (standings.length === 0) {
        return (
            <View style={styles.empty}>
                <Text style={styles.emptyText}>
                    No standings yet — matchups will appear once games are scored.
                </Text>
            </View>
        )
    }

    return (
        <FlatList
            data={standings}
            keyExtractor={(s) => s.memberId}
            ListHeaderComponent={() => (
                <View style={[styles.standingsRow, styles.standingsHeader]}>
                    <Text style={[styles.standingsRank, styles.standingsHeaderText]}>#</Text>
                    <Text style={[styles.standingsTeam, styles.standingsHeaderText]}>Team</Text>
                    <Text style={[styles.standingsCell, styles.standingsHeaderText]}>W</Text>
                    <Text style={[styles.standingsCell, styles.standingsHeaderText]}>L</Text>
                    <Text style={[styles.standingsPts, styles.standingsHeaderText]}>PF</Text>
                    <Text style={[styles.standingsPts, styles.standingsHeaderText]}>PA</Text>
                </View>
            )}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            renderItem={({ item, index }) => {
                const isMe = item.memberId === myMemberId
                return (
                    <View style={[styles.standingsRow, isMe && styles.standingsRowMe]}>
                        <Text style={[styles.standingsRank, isMe && styles.standingsMe]}>
                            {index + 1}
                        </Text>
                        <Text
                            style={[styles.standingsTeam, isMe && styles.standingsMe]}
                            numberOfLines={1}
                        >
                            {item.teamName}
                        </Text>
                        <Text style={[styles.standingsCell, isMe && styles.standingsMe]}>
                            {item.wins}
                        </Text>
                        <Text style={[styles.standingsCell, isMe && styles.standingsMe]}>
                            {item.losses}
                        </Text>
                        <Text style={[styles.standingsPts, isMe && styles.standingsMe]}>
                            {item.pointsFor.toFixed(1)}
                        </Text>
                        <Text style={[styles.standingsPts, isMe && styles.standingsMe]}>
                            {item.pointsAgainst.toFixed(1)}
                        </Text>
                    </View>
                )
            }}
        />
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#fff' },

    header: { padding: 20, borderBottomWidth: 1, borderBottomColor: '#eee', gap: 12 },
    headerTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    headerInfo: { flex: 1, gap: 2 },
    leagueName: { fontSize: 20, fontWeight: '800' },
    teamName: { fontSize: 14, color: '#888' },

    settingsButton: {
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#ddd',
    },
    settingsButtonText: { fontSize: 13, fontWeight: '600', color: '#555' },

    draftButton: {
        backgroundColor: '#F97316',
        borderRadius: 10,
        height: 44,
        justifyContent: 'center',
        alignItems: 'center',
    },
    draftButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },

    inviteRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: '#f9f9f9',
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 10,
    },
    inviteLabel: { fontSize: 13, color: '#888', flex: 1 },
    inviteCode: { fontSize: 15, fontWeight: '800', color: '#111', letterSpacing: 2 },
    inviteCopy: { fontSize: 13, color: '#F97316', fontWeight: '600' },

    sectionTitle: {
        fontSize: 13,
        fontWeight: '700',
        color: '#aaa',
        letterSpacing: 0.5,
        paddingHorizontal: 20,
        paddingTop: 16,
        paddingBottom: 8,
    },

    memberRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 12,
    },
    separator: { height: 1, backgroundColor: '#f3f3f3', marginLeft: 72 },

    memberAvatar: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: '#F97316',
        justifyContent: 'center',
        alignItems: 'center',
    },
    memberAvatarText: { color: '#fff', fontWeight: '700', fontSize: 16 },

    memberInfo: { flex: 1, gap: 2 },
    memberTeam: { fontSize: 15, fontWeight: '600' },
    meTag: { color: '#aaa', fontWeight: '400', fontSize: 13 },
    memberName: { fontSize: 13, color: '#888' },

    roleBadge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: '#f3f3f3',
    },
    roleBadgeCommissioner: { backgroundColor: '#FEF3C7' },
    roleText: { fontSize: 11, fontWeight: '700', color: '#888' },
    roleTextCommissioner: { color: '#D97706' },

    tabRow: {
        flexDirection: 'row',
        gap: 8,
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    tabChip: {
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 20,
        backgroundColor: '#f3f3f3',
    },
    tabChipActive: { backgroundColor: '#F97316' },
    tabChipText: { fontSize: 13, fontWeight: '600', color: '#555' },
    tabChipTextActive: { color: '#fff' },

    standingsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 11,
    },
    standingsRowMe: { backgroundColor: '#FFF7ED' },
    standingsHeader: { borderBottomWidth: 1, borderBottomColor: '#eee', paddingVertical: 8 },
    standingsHeaderText: { fontSize: 11, fontWeight: '700', color: '#aaa' },
    standingsRank: { width: 24, fontSize: 14, fontWeight: '700', color: '#555' },
    standingsTeam: { flex: 1, fontSize: 14, fontWeight: '600', color: '#111' },
    standingsCell: { width: 28, textAlign: 'center', fontSize: 14, color: '#555' },
    standingsPts: { width: 52, textAlign: 'right', fontSize: 13, color: '#555' },
    standingsMe: { color: '#F97316', fontWeight: '700' },

    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
    emptyText: { fontSize: 14, color: '#aaa', textAlign: 'center' },
})
