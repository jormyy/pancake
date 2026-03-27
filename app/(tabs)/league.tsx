import {
    View,
    Text,
    ScrollView,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    Share,
    Alert,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { getLeagueMembers } from '@/lib/league'
import { getLeagueStandings, StandingRow } from '@/lib/scoring'
import { getActiveDraft, startDraft } from '@/lib/draft'
import { getWaiverPriorityOrder, WaiverPriorityRow } from '@/lib/waivers'
import { getLeagueTransactions, TransactionRow, TRANSACTION_LABELS } from '@/lib/transactions'
import { getActiveRookieDraft, startRookieDraft, getAllLeaguePicks, type LeaguePickItem } from '@/lib/rookieDraft'
import { POSITION_COLORS } from '@/constants/positions'
import { bgStyle } from '@/lib/style-cache'

const ROLE_LABELS: Record<string, string> = {
    commissioner: 'Commissioner',
    co_commissioner: 'Co-Comm',
    manager: 'Manager',
}

type Tab = 'standings' | 'activity' | 'waivers' | 'members' | 'picks'

const ItemSeparator = () => <View style={styles.separator} />

const shortDateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

function getInitials(name: string): string {
    return name.split(' ').map((w: string) => w[0]).slice(0, 2).join('')
}

// ── Extracted list item components ───────────────────────────────

function MemberRow({ item, isMe }: { item: any; isMe: boolean }) {
    const profile = item.profiles as any
    return (
        <View style={styles.memberRow}>
            <View style={styles.memberAvatar}>
                <Text style={styles.memberAvatarText}>
                    {(item.team_name ?? profile?.display_name ?? '?')[0].toUpperCase()}
                </Text>
            </View>
            <View style={styles.memberInfo}>
                <Text style={styles.memberTeam}>
                    {item.team_name ?? 'Unnamed Team'}
                    {isMe ? <Text style={styles.meTag}> (you)</Text> : null}
                </Text>
                <Text style={styles.memberName}>
                    {profile?.display_name ?? profile?.username}
                </Text>
            </View>
            <View style={[styles.roleBadge, item.role === 'commissioner' && styles.roleBadgeCommissioner]}>
                <Text style={[styles.roleText, item.role === 'commissioner' && styles.roleTextCommissioner]}>
                    {ROLE_LABELS[item.role] ?? item.role}
                </Text>
            </View>
        </View>
    )
}

function StandingsRow({ item, index, isMe }: { item: StandingRow; index: number; isMe: boolean }) {
    return (
        <View style={[styles.standingsRow, isMe && styles.standingsRowMe]}>
            <Text style={[styles.standingsRank, isMe && styles.standingsMe]}>{index + 1}</Text>
            <Text style={[styles.standingsTeam, isMe && styles.standingsMe]} numberOfLines={1}>
                {item.teamName}
            </Text>
            <Text style={[styles.standingsCell, isMe && styles.standingsMe]}>{item.wins}</Text>
            <Text style={[styles.standingsCell, isMe && styles.standingsMe]}>{item.losses}</Text>
            <Text style={[styles.standingsPts, isMe && styles.standingsMe]}>{item.pointsFor.toFixed(1)}</Text>
            <Text style={[styles.standingsPts, isMe && styles.standingsMe]}>{item.pointsAgainst.toFixed(1)}</Text>
        </View>
    )
}

function ActivityRow({ item, isMe }: { item: TransactionRow; isMe: boolean }) {
    const color = TX_COLORS[item.transactionType] ?? '#888'
    const label = TRANSACTION_LABELS[item.transactionType] ?? item.transactionType
    const pos = item.position ?? ''
    return (
        <View style={[styles.txRow, isMe && styles.txRowMe]}>
            <View style={[styles.txAvatar, bgStyle(POSITION_COLORS[pos] ?? '#ccc')]}>
                <Text style={styles.txAvatarText}>{getInitials(item.playerName)}</Text>
            </View>
            <View style={styles.txInfo}>
                <Text style={styles.txPlayer} numberOfLines={1}>
                    {item.playerName}
                    {pos ? <Text style={styles.txPos}>  {pos}</Text> : null}
                </Text>
                <Text style={styles.txTeam} numberOfLines={1}>
                    {item.teamName}
                    {isMe ? <Text style={styles.meTag}> (you)</Text> : null}
                </Text>
            </View>
            <View style={styles.txRight}>
                <View style={[styles.txLabel, bgStyle(color + '22')]}>
                    <Text style={[styles.txLabelText, { color }]}>{label}</Text>
                </View>
                <Text style={styles.txTime}>{timeAgo(item.occurredAt)}</Text>
            </View>
        </View>
    )
}

function WaiverRow({ item, isMe }: { item: WaiverPriorityRow; isMe: boolean }) {
    return (
        <View style={[styles.waiverRow, isMe && styles.standingsRowMe]}>
            <Text style={[styles.waiverRank, isMe && styles.standingsMe]}>{item.priority}</Text>
            <Text style={[styles.waiverTeam, isMe && styles.standingsMe]} numberOfLines={1}>
                {item.teamName}
            </Text>
            <Text style={[styles.waiverName, isMe && styles.standingsMe]} numberOfLines={1}>
                {item.displayName}
            </Text>
        </View>
    )
}

// ── Picks Bank flattened item types ──────────────────────────────

type PicksBankItem =
    | { type: 'yearHeader'; year: number; id: string }
    | { type: 'pick'; pick: LeaguePickItem; id: string }

function PicksBankYearHeader({ year }: { year: number }) {
    return (
        <View style={styles.picksBankYearRow}>
            <Text style={styles.picksBankYear}>{year}</Text>
        </View>
    )
}

function PicksBankRow({ pick, isMine }: { pick: LeaguePickItem; isMine: boolean }) {
    const isTraded = pick.originalOwnerMemberId !== pick.currentOwnerMemberId
    return (
        <View style={[styles.picksBankRow, isMine && styles.standingsRowMe]}>
            <Text style={[styles.picksBankRound, isMine && styles.standingsMe]}>R{pick.round}</Text>
            <Text style={[styles.picksBankFrom, isMine && styles.standingsMe]} numberOfLines={1}>
                {pick.originalTeamName}{isTraded ? ' *' : ''}
            </Text>
            <Text style={[styles.picksBankOwner, isMine && styles.standingsMe]} numberOfLines={1}>
                {isMine ? 'You' : pick.currentTeamName}
            </Text>
        </View>
    )
}

// ── Main screen ──────────────────────────────────────────────────

export default function LeagueScreen() {
    const { push } = useRouter()
    const { current, loading: leagueLoading } = useLeagueContext()
    const { user } = useAuth()
    const [tab, setTab] = useState<Tab>('standings')
    const [members, setMembers] = useState<any[]>([])
    const [standings, setStandings] = useState<StandingRow[]>([])
    const [waiverOrder, setWaiverOrder] = useState<WaiverPriorityRow[]>([])
    const [transactions, setTransactions] = useState<TransactionRow[]>([])
    const [leaguePicks, setLeaguePicks] = useState<LeaguePickItem[]>([])
    const [loading, setLoading] = useState(true)
    const [draftLoading, setDraftLoading] = useState(false)

    const league = current?.leagues as any
    const isCommissioner = league?.commissioner_id === user?.id

    const load = useCallback(async () => {
        if (!current) return
        setLoading(true)
        try {
            const [memberData, standingsData, waiverData, txData, picksData] = await Promise.all([
                getLeagueMembers(league.id),
                getLeagueStandings(league.id),
                getWaiverPriorityOrder(league.id),
                getLeagueTransactions(league.id),
                getAllLeaguePicks(league.id),
            ])
            setMembers(memberData)
            setStandings(standingsData)
            setWaiverOrder(waiverData)
            setTransactions(txData)
            setLeaguePicks(picksData)
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
            push({ pathname: '/(modals)/draft-room', params: { draftId: draft.id } })
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
            if (draft.draftType === 'snake') {
                push({ pathname: '/(modals)/rookie-draft-room' as any, params: { draftId: draft.id } })
            } else {
                push({ pathname: '/(modals)/draft-room', params: { draftId: draft.id } })
            }
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setDraftLoading(false)
        }
    }

    async function handleStartRookieDraft() {
        if (!league?.id) return
        setDraftLoading(true)
        try {
            const result = await startRookieDraft(league.id)
            push({ pathname: '/(modals)/rookie-draft-room' as any, params: { draftId: result.draft.id } })
        } catch (e: any) {
            Alert.alert('Could not start rookie draft', e.message)
        } finally {
            setDraftLoading(false)
        }
    }

    async function handleJoinRookieDraft() {
        if (!league?.id) return
        setDraftLoading(true)
        try {
            const draft = await getActiveRookieDraft(league.id)
            if (!draft) {
                Alert.alert('No active rookie draft found')
                return
            }
            push({ pathname: '/(modals)/rookie-draft-room' as any, params: { draftId: draft.id } })
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
                <ActivityIndicator style={styles.flex1} color="#F97316" />
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
                    <View style={styles.headerButtons}>
                        <Pressable
                            style={styles.settingsButton}
                            onPress={() => push('/(modals)/bracket')}
                        >
                            <Text style={styles.settingsButtonText}>Bracket</Text>
                        </Pressable>
                        <Pressable
                            style={styles.settingsButton}
                            onPress={() => push('/(modals)/trades')}
                        >
                            <Text style={styles.settingsButtonText}>Trades</Text>
                        </Pressable>
                        {isCommissioner ? (
                            <Pressable
                                style={styles.settingsButton}
                                onPress={() => push('/(modals)/commissioner-settings')}
                            >
                                <Text style={styles.settingsButtonText}>Settings</Text>
                            </Pressable>
                        ) : null}
                    </View>
                </View>

                {/* Invite code */}
                <Pressable
                    style={styles.inviteRow}
                    onPress={shareInviteCode}
                >
                    <Text style={styles.inviteLabel}>Invite Code</Text>
                    <Text style={styles.inviteCode}>{league?.invite_code}</Text>
                    <Text style={styles.inviteCopy}>Share</Text>
                </Pressable>

                {/* Draft actions */}
                {league?.status === 'setup' && isCommissioner ? (
                    <Pressable style={styles.draftButton} onPress={handleStartDraft} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.draftButtonText}>Start Auction Draft</Text>}
                    </Pressable>
                ) : null}
                {league?.status === 'drafting' ? (
                    <Pressable style={styles.draftButton} onPress={handleJoinDraftRoom} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.draftButtonText}>Join Draft Room</Text>}
                    </Pressable>
                ) : null}
                {league?.status === 'offseason' && isCommissioner ? (
                    <Pressable style={styles.draftButton} onPress={handleStartRookieDraft} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.draftButtonText}>Start Rookie Draft</Text>}
                    </Pressable>
                ) : null}
                {league?.status === 'offseason' && !isCommissioner ? (
                    <Pressable style={styles.draftButton} onPress={handleJoinRookieDraft} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.draftButtonText}>Join Rookie Draft</Text>}
                    </Pressable>
                ) : null}
            </View>

            {/* Tab switcher */}
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.tabRow}
                contentContainerStyle={styles.tabRowContent}
            >
                {(['standings', 'activity', 'waivers', 'members', 'picks'] as Tab[]).map((t) => (
                    <Pressable
                        key={t}
                        style={[styles.tabChip, tab === t && styles.tabChipActive]}
                        onPress={() => setTab(t)}
                    >
                        <Text style={[styles.tabChipText, tab === t && styles.tabChipTextActive]}>
                            {t === 'standings' ? 'Standings'
                                : t === 'activity' ? 'Activity'
                                : t === 'waivers' ? 'Waivers'
                                : t === 'picks' ? 'Picks'
                                : 'Teams'}
                        </Text>
                    </Pressable>
                ))}
            </ScrollView>

            {loading ? (
                <ActivityIndicator style={styles.loadingMargin} color="#F97316" />
            ) : tab === 'standings' ? (
                <StandingsTable standings={standings} myMemberId={current?.id} />
            ) : tab === 'activity' ? (
                <ActivityFeed transactions={transactions} myMemberId={current?.id} />
            ) : tab === 'waivers' ? (
                <WaiverPriorityList rows={waiverOrder} myMemberId={current?.id} />
            ) : tab === 'picks' ? (
                <PicksBankList picks={leaguePicks} myMemberId={current?.id} />
            ) : (
                <FlashList
                    data={members}
                    keyExtractor={(m) => m.id}
                    ItemSeparatorComponent={ItemSeparator}
                    renderItem={({ item }) => (
                        <MemberRow item={item} isMe={item.user_id === user?.id} />
                    )}
                />
            )}
        </SafeAreaView>
    )
}

// ── Sub-list components ──────────────────────────────────────────

function StandingsTable({ standings, myMemberId }: { standings: StandingRow[]; myMemberId?: string }) {
    if (standings.length === 0) {
        return (
            <View style={styles.empty}>
                <Text style={styles.emptyText}>No standings yet — matchups will appear once games are scored.</Text>
            </View>
        )
    }

    return (
        <FlashList
            data={standings}
            keyExtractor={(s) => s.memberId}
            ListHeaderComponent={StandingsListHeader}
            ItemSeparatorComponent={ItemSeparator}
            renderItem={({ item, index }) => (
                <StandingsRow item={item} index={index} isMe={item.memberId === myMemberId} />
            )}
        />
    )
}

const TX_COLORS: Record<string, string> = {
    fa_add: '#10B981',
    waiver_add: '#8B5CF6',
    trade_in: '#3B82F6',
    fa_drop: '#EF4444',
    waiver_drop: '#EF4444',
    trade_out: '#F97316',
    ir_designate: '#F59E0B',
    ir_return: '#6366F1',
    draft_won: '#10B981',
}

function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diff / 60_000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    if (days < 7) return `${days}d ago`
    return shortDateFmt.format(new Date(iso))
}

function ActivityFeed({ transactions, myMemberId }: { transactions: TransactionRow[]; myMemberId?: string }) {
    if (transactions.length === 0) {
        return (
            <View style={styles.empty}>
                <Text style={styles.emptyText}>No transactions yet. Adds, drops, and trades will appear here.</Text>
            </View>
        )
    }

    return (
        <FlashList
            data={transactions}
            keyExtractor={(t) => t.id}
            ItemSeparatorComponent={ItemSeparator}
            renderItem={({ item }) => (
                <ActivityRow item={item} isMe={item.memberId === myMemberId} />
            )}
        />
    )
}

function WaiverPriorityList({ rows, myMemberId }: { rows: WaiverPriorityRow[]; myMemberId?: string }) {
    if (rows.length === 0) {
        return (
            <View style={styles.empty}>
                <Text style={styles.emptyText}>Waiver priorities will appear here once the season starts.</Text>
            </View>
        )
    }

    return (
        <FlashList
            data={rows}
            keyExtractor={(r) => r.memberId}
            ListHeaderComponent={WaiverListHeader}
            ItemSeparatorComponent={ItemSeparator}
            renderItem={({ item }) => (
                <WaiverRow item={item} isMe={item.memberId === myMemberId} />
            )}
        />
    )
}

function PicksBankList({ picks, myMemberId }: { picks: LeaguePickItem[]; myMemberId?: string }) {
    const flatData = useMemo<PicksBankItem[]>(() => {
        const byYear = new Map<number, LeaguePickItem[]>()
        for (const p of picks) {
            if (!byYear.has(p.seasonYear)) byYear.set(p.seasonYear, [])
            byYear.get(p.seasonYear)!.push(p)
        }
        const result: PicksBankItem[] = []
        for (const [year, yearPicks] of Array.from(byYear.entries()).sort((a, b) => a[0] - b[0])) {
            result.push({ type: 'yearHeader', year, id: `year-${year}` })
            for (const p of yearPicks) {
                result.push({ type: 'pick', pick: p, id: p.id })
            }
        }
        return result
    }, [picks])

    if (picks.length === 0) {
        return (
            <View style={styles.empty}>
                <Text style={styles.emptyText}>No future draft picks to display.</Text>
            </View>
        )
    }

    return (
        <FlashList
            data={flatData}
            keyExtractor={(item) => item.id}
            ListHeaderComponent={PicksBankListHeader}
            getItemType={(item) => item.type}
            ItemSeparatorComponent={ItemSeparator}
            renderItem={({ item }) => {
                if (item.type === 'yearHeader') {
                    return <PicksBankYearHeader year={item.year} />
                }
                return (
                    <PicksBankRow
                        pick={item.pick}
                        isMine={item.pick.currentOwnerMemberId === myMemberId}
                    />
                )
            }}
        />
    )
}

// ── Styles ───────────────────────────────────────────────────────

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#fff' },
    flex1: { flex: 1 },
    loadingMargin: { marginTop: 24 },

    header: { padding: 20, borderBottomWidth: 1, borderBottomColor: '#eee', gap: 12 },
    headerTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    headerInfo: { flex: 1, gap: 2 },
    leagueName: { fontSize: 20, fontWeight: '800' },
    teamName: { fontSize: 14, color: '#888' },

    headerButtons: { flexDirection: 'row', gap: 8, alignItems: 'center' },
    settingsButton: {
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 8,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: '#ddd',
    },
    settingsButtonText: { fontSize: 13, fontWeight: '600', color: '#555' },

    draftButton: {
        backgroundColor: '#F97316',
        borderRadius: 10,
        borderCurve: 'continuous' as const,
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
        borderCurve: 'continuous' as const,
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
        borderCurve: 'continuous' as const,
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
        borderCurve: 'continuous' as const,
        backgroundColor: '#f3f3f3',
    },
    roleBadgeCommissioner: { backgroundColor: '#FEF3C7' },
    roleText: { fontSize: 11, fontWeight: '700', color: '#888' },
    roleTextCommissioner: { color: '#D97706' },

    tabRow: {
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
        flexGrow: 0,
        flexShrink: 0,
    },
    tabRowContent: {
        flexDirection: 'row',
        gap: 8,
        paddingHorizontal: 20,
        paddingVertical: 12,
    },
    tabChip: {
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 20,
        borderCurve: 'continuous' as const,
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

    waiverRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 11,
    },
    waiverHeader: { borderBottomWidth: 1, borderBottomColor: '#eee', paddingVertical: 8 },
    waiverRank: { width: 32, fontSize: 14, fontWeight: '700', color: '#555' },
    waiverTeam: { flex: 1, fontSize: 14, fontWeight: '600', color: '#111' },
    waiverName: { width: 110, textAlign: 'right', fontSize: 13, color: '#888' },

    txRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 12,
    },
    txRowMe: { backgroundColor: '#FFF7ED' },
    txAvatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    txAvatarText: { color: '#fff', fontWeight: '700', fontSize: 13 },
    txInfo: { flex: 1, gap: 2 },
    txPlayer: { fontSize: 14, fontWeight: '600', color: '#111' },
    txPos: { fontSize: 12, color: '#aaa', fontWeight: '400' },
    txTeam: { fontSize: 12, color: '#888' },
    txRight: { alignItems: 'flex-end', gap: 4 },
    txLabel: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        borderCurve: 'continuous' as const,
    },
    txLabelText: { fontSize: 11, fontWeight: '700' },
    txTime: { fontSize: 11, color: '#aaa' },

    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
    emptyText: { fontSize: 14, color: '#aaa', textAlign: 'center' },

    picksBankHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    picksBankHeaderFrom: { flex: 1, marginLeft: 12 },
    picksBankHeaderOwner: { width: 110, textAlign: 'right' },
    picksBankYearRow: {
        paddingHorizontal: 16,
        paddingVertical: 6,
        backgroundColor: '#f9f9f9',
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    picksBankYear: { fontSize: 12, fontWeight: '800', color: '#888', letterSpacing: 0.5 },
    picksBankRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    picksBankRound: { width: 36, fontSize: 14, fontWeight: '700', color: '#555' },
    picksBankFrom: { flex: 1, fontSize: 13, color: '#555', marginLeft: 12 },
    picksBankOwner: { width: 110, textAlign: 'right', fontSize: 13, fontWeight: '600', color: '#111' },
})

const StandingsListHeader = (
    <View style={[styles.standingsRow, styles.standingsHeader]}>
        <Text style={[styles.standingsRank, styles.standingsHeaderText]}>#</Text>
        <Text style={[styles.standingsTeam, styles.standingsHeaderText]}>Team</Text>
        <Text style={[styles.standingsCell, styles.standingsHeaderText]}>W</Text>
        <Text style={[styles.standingsCell, styles.standingsHeaderText]}>L</Text>
        <Text style={[styles.standingsPts, styles.standingsHeaderText]}>PF</Text>
        <Text style={[styles.standingsPts, styles.standingsHeaderText]}>PA</Text>
    </View>
)

const WaiverListHeader = (
    <View style={[styles.waiverRow, styles.waiverHeader]}>
        <Text style={[styles.waiverRank, styles.standingsHeaderText]}>#</Text>
        <Text style={[styles.waiverTeam, styles.standingsHeaderText]}>Team</Text>
        <Text style={[styles.waiverName, styles.standingsHeaderText]}>Manager</Text>
    </View>
)

const PicksBankListHeader = (
    <View style={styles.picksBankHeader}>
        <Text style={styles.standingsHeaderText}>ROUND</Text>
        <Text style={[styles.standingsHeaderText, styles.picksBankHeaderFrom]}>FROM</Text>
        <Text style={[styles.standingsHeaderText, styles.picksBankHeaderOwner]}>OWNER</Text>
    </View>
)
