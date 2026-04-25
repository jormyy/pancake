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
import { useMemo, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { getLeagueStandings, StandingRow } from '@/lib/scoring'
import { getActiveDraft, startDraft } from '@/lib/draft'
import { getWaiverPriorityOrder, WaiverPriorityRow } from '@/lib/waivers'
import { getLeagueTransactions, TransactionRow, TRANSACTION_LABELS } from '@/lib/transactions'
import { getActiveRookieDraft, startRookieDraft, getAllLeaguePicks, reseedRookieDraftPicks, type LeaguePickItem } from '@/lib/rookieDraft'
import { POSITION_COLORS } from '@/constants/positions'
import { colors, palette, fontSize, fontWeight, radii, spacing, TX_COLORS } from '@/constants/tokens'
import { shortDateFmt } from '@/lib/format'
import { ItemSeparator } from '@/components/ItemSeparator'
import { LoadingScreen } from '@/components/LoadingScreen'
import { EmptyState } from '@/components/EmptyState'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { SectionHeader } from '@/components/SectionHeader'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'

type Tab = 'standings' | 'activity' | 'waivers' | 'picks'

// ── Extracted list item components ───────────────────────────────

function StandingsRow({ item, index, isMe, onPress }: { item: StandingRow; index: number; isMe: boolean; onPress: () => void }) {
    return (
        <Pressable style={[styles.standingsRow, isMe && styles.standingsRowMe]} onPress={onPress}>
            <Text style={[styles.standingsRank, isMe && styles.standingsMe]}>{index + 1}</Text>
            <Text style={[styles.standingsTeam, isMe && styles.standingsMe]} numberOfLines={1}>
                {item.teamName}
            </Text>
            <Text style={[styles.standingsCell, isMe && styles.standingsMe]}>{item.wins}</Text>
            <Text style={[styles.standingsCell, isMe && styles.standingsMe]}>{item.losses}</Text>
            <Text style={[styles.standingsPts, isMe && styles.standingsMe]}>{item.pointsFor.toFixed(1)}</Text>
            <Text style={[styles.standingsPts, isMe && styles.standingsMe]}>{item.maxPointsFor.toFixed(1)}</Text>
            <Text style={[styles.standingsPts, isMe && styles.standingsMe]}>{item.pointsAgainst.toFixed(1)}</Text>
        </Pressable>
    )
}

function ActivityRow({ item, isMe }: { item: TransactionRow; isMe: boolean }) {
    const color = TX_COLORS[item.transactionType] ?? colors.textMuted
    const label = TRANSACTION_LABELS[item.transactionType] ?? item.transactionType
    return (
        <View style={[styles.txRow, isMe && styles.txRowMe]}>
            <Avatar
                name={item.playerName}
                color={POSITION_COLORS[item.eligiblePositions[0] ?? item.position ?? ''] ?? palette.gray500}
                size={40}
                uri={item.nbaId ? `https://cdn.nba.com/headshots/nba/latest/260x190/${item.nbaId}.png` : null}
            />
            <View style={styles.txInfo}>
                <View style={styles.txNameRow}>
                    <Text style={styles.txPlayer} numberOfLines={1}>{item.playerName}</Text>
                    {item.eligiblePositions.map((pos) => <PosTag key={pos} position={pos} />)}
                </View>
                <Text style={styles.txTeam} numberOfLines={1}>
                    {item.teamName}
                    {isMe ? <Text style={styles.meTag}> (you)</Text> : null}
                </Text>
            </View>
            <View style={styles.txRight}>
                <Badge label={label} color={color} variant="soft" />
                <Text style={styles.txTime}>{timeAgo(item.occurredAt)}</Text>
            </View>
        </View>
    )
}

function WaiverRow({ item, isMe, rank }: { item: WaiverPriorityRow; isMe: boolean; rank: number }) {
    return (
        <View style={[styles.waiverRow, isMe && styles.standingsRowMe]}>
            <Text style={[styles.waiverRank, isMe && styles.standingsMe]}>{rank}</Text>
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
    return <SectionHeader label={String(year)} />
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
    const { current, currentLeague, isCommissioner, loading: currentLeagueLoading } = useLeagueContext()
    const { user } = useAuth()
    const [tab, setTab] = useState<Tab>('standings')
    const [draftLoading, setDraftLoading] = useState(false)

    const { data, loading } = useFocusAsyncData(async () => {
        if (!current || !currentLeague) return null
        const lid = currentLeague.id
        const [standingsData, waiverData, txData, picksData] = await Promise.all([
            getLeagueStandings(lid),
            getWaiverPriorityOrder(lid),
            getLeagueTransactions(lid),
            getAllLeaguePicks(lid),
        ])
        return {
            standings: standingsData,
            waiverOrder: waiverData,
            transactions: txData,
            currentLeaguePicks: picksData,
        }
    }, [current])

    const standings = data?.standings ?? []
    const waiverOrder = data?.waiverOrder ?? []
    const transactions = data?.transactions ?? []
    const currentLeaguePicks = data?.currentLeaguePicks ?? []

    async function handleStartDraft() {
        if (!currentLeague?.id) return
        setDraftLoading(true)
        try {
            const draft = await startDraft(currentLeague.id)
            push({ pathname: '/(modals)/draft-room', params: { draftId: draft.id } })
        } catch (e: any) {
            Alert.alert('Could not start draft', e.message)
        } finally {
            setDraftLoading(false)
        }
    }

    async function handleJoinDraftRoom() {
        if (!currentLeague?.id) return
        setDraftLoading(true)
        try {
            const draft = await getActiveDraft(currentLeague.id)
            if (!draft) {
                Alert.alert('No active draft found')
                return
            }
            if (draft.draftType === 'snake') {
                push({ pathname: '/(modals)/rookie-draft-room', params: { draftId: draft.id } })
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
        if (!currentLeague?.id) return
        setDraftLoading(true)
        try {
            const result = await startRookieDraft(currentLeague.id)
            push({ pathname: '/(modals)/rookie-draft-room', params: { draftId: result.draft.id } })
        } catch (e: any) {
            Alert.alert('Could not start rookie draft', e.message)
        } finally {
            setDraftLoading(false)
        }
    }

    async function handleReseedRookiePicks() {
        if (!currentLeague?.id) return
        setDraftLoading(true)
        try {
            const draft = await getActiveRookieDraft(currentLeague.id)
            if (!draft) { Alert.alert('No active rookie draft found'); return }
            await reseedRookieDraftPicks(draft.id)
            Alert.alert('Done', 'Pick slots updated to reflect traded picks.')
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setDraftLoading(false)
        }
    }

    async function handleJoinRookieDraft() {
        if (!currentLeague?.id) return
        setDraftLoading(true)
        try {
            const draft = await getActiveRookieDraft(currentLeague.id)
            if (!draft) {
                Alert.alert('No active rookie draft found')
                return
            }
            push({ pathname: '/(modals)/rookie-draft-room', params: { draftId: draft.id } })
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setDraftLoading(false)
        }
    }

    async function shareInviteCode() {
        await Share.share({
            message: `Join my Pancake currentLeague! Use invite code: ${currentLeague?.invite_code}`,
        })
    }

    if (currentLeagueLoading || (!current && loading)) {
        return <LoadingScreen />
    }

    if (!current) {
        return <EmptyState message="Join or create a currentLeague first." />
    }

    return (
        <SafeAreaView style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.headerTop}>
                    <View style={styles.headerInfo}>
                        <Text style={styles.currentLeagueName}>{currentLeague?.name}</Text>
                        <Text style={styles.teamName}>{current.team_name}</Text>
                    </View>
                    <View style={styles.headerButtons}>
                        <Pressable
                            style={styles.settingsButton}
                            onPress={() => push('/(modals)/bracket')}
                        >
                            <Text style={styles.settingsButtonText}>Bracket</Text>
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
                    <Text style={styles.inviteCode}>{currentLeague?.invite_code}</Text>
                    <Text style={styles.inviteCopy}>Share</Text>
                </Pressable>

                {/* Draft actions */}
                {currentLeague?.status === 'setup' && isCommissioner ? (
                    <Pressable style={styles.draftButton} onPress={handleStartDraft} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color={colors.textWhite} /> : <Text style={styles.draftButtonText}>Start Auction Draft</Text>}
                    </Pressable>
                ) : null}
                {currentLeague?.status === 'drafting' ? (
                    <Pressable style={styles.draftButton} onPress={handleJoinDraftRoom} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color={colors.textWhite} /> : <Text style={styles.draftButtonText}>Join Draft Room</Text>}
                    </Pressable>
                ) : null}
                {currentLeague?.status === 'drafting' && isCommissioner ? (
                    <Pressable style={[styles.draftButton, { backgroundColor: colors.bgSubtle, borderWidth: 1, borderColor: colors.border, marginTop: 8 }]} onPress={handleReseedRookiePicks} disabled={draftLoading}>
                        <Text style={[styles.draftButtonText, { color: colors.textSecondary }]}>Fix Traded Pick Slots</Text>
                    </Pressable>
                ) : null}
                {currentLeague?.status === 'offseason' && isCommissioner ? (
                    <Pressable style={styles.draftButton} onPress={handleStartRookieDraft} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color={colors.textWhite} /> : <Text style={styles.draftButtonText}>Start Rookie Draft</Text>}
                    </Pressable>
                ) : null}
                {currentLeague?.status === 'offseason' && !isCommissioner ? (
                    <Pressable style={styles.draftButton} onPress={handleJoinRookieDraft} disabled={draftLoading}>
                        {draftLoading ? <ActivityIndicator size="small" color={colors.textWhite} /> : <Text style={styles.draftButtonText}>Join Rookie Draft</Text>}
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
                {(['standings', 'activity', 'waivers', 'picks'] as Tab[]).map((t) => (
                    <Pressable
                        key={t}
                        style={[styles.tabChip, tab === t && styles.tabChipActive]}
                        onPress={() => setTab(t)}
                    >
                        <Text style={[styles.tabChipText, tab === t && styles.tabChipTextActive]}>
                            {t === 'standings' ? 'Standings'
                                : t === 'activity' ? 'Activity'
                                : t === 'waivers' ? 'Waivers'
                                : 'Picks'}
                        </Text>
                    </Pressable>
                ))}
            </ScrollView>

            {loading ? (
                <ActivityIndicator style={styles.loadingMargin} color={colors.primary} />
            ) : tab === 'standings' ? (
                <StandingsTable
                    standings={standings}
                    myMemberId={current?.id}
                    onSelectTeam={(memberId, teamName) =>
                        push({ pathname: '/(modals)/team-roster', params: { memberId, teamName } })
                    }
                />
            ) : tab === 'activity' ? (
                <ActivityFeed transactions={transactions} myMemberId={current?.id} />
            ) : tab === 'waivers' ? (
                <WaiverPriorityList rows={waiverOrder} myMemberId={current?.id} />
            ) : (
                <PicksBankList picks={currentLeaguePicks} myMemberId={current?.id} />
            )}
        </SafeAreaView>
    )
}

// ── Sub-list components ──────────────────────────────────────────

function StandingsTable({ standings, myMemberId, onSelectTeam }: { standings: StandingRow[]; myMemberId?: string; onSelectTeam: (memberId: string, teamName: string) => void }) {
    if (standings.length === 0) {
        return <EmptyState message="No standings yet — matchups will appear once games are scored." fullScreen={false} />
    }

    return (
        <FlashList
            data={standings}
            keyExtractor={(s) => s.memberId}
            ListHeaderComponent={StandingsListHeader}
            ItemSeparatorComponent={ItemSeparator}
            renderItem={({ item, index }) => (
                <StandingsRow
                    item={item}
                    index={index}
                    isMe={item.memberId === myMemberId}
                    onPress={() => onSelectTeam(item.memberId, item.teamName)}
                />
            )}
        />
    )
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
        return <EmptyState message="No transactions yet. Adds, drops, and trades will appear here." fullScreen={false} />
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
        return <EmptyState message="Waiver priorities will appear here once the season starts." fullScreen={false} />
    }

    return (
        <FlashList
            data={rows}
            keyExtractor={(r) => r.memberId}
            ListHeaderComponent={WaiverListHeader}
            ItemSeparatorComponent={ItemSeparator}
            renderItem={({ item, index }) => (
                <WaiverRow item={item} isMe={item.memberId === myMemberId} rank={index + 1} />
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
        return <EmptyState message="No future draft picks to display." fullScreen={false} />
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
    container: { flex: 1, backgroundColor: colors.bgScreen },
    loadingMargin: { marginTop: spacing['3xl'] },

    header: { padding: spacing['2xl'], borderBottomWidth: 1, borderBottomColor: colors.borderLight, gap: spacing.lg },
    headerTop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.lg },
    headerInfo: { flex: 1, gap: spacing.xxs },
    currentLeagueName: { fontSize: fontSize.xl, fontWeight: fontWeight.extrabold },
    teamName: { fontSize: fontSize.md, color: colors.textMuted },

    headerButtons: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
    settingsButton: {
        paddingHorizontal: spacing.lg,
        paddingVertical: 7,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
    },
    settingsButtonText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },

    draftButton: {
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        height: 44,
        justifyContent: 'center',
        alignItems: 'center',
    },
    draftButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },

    inviteRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        backgroundColor: palette.gray100,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 14,
        paddingVertical: spacing.lg,
    },
    inviteLabel: { fontSize: fontSize.sm, color: colors.textMuted, flex: 1 },
    inviteCode: { fontSize: 15, fontWeight: fontWeight.extrabold, color: colors.textPrimary, letterSpacing: 2 },
    inviteCopy: { fontSize: fontSize.sm, color: colors.primary, fontWeight: fontWeight.semibold },

    meTag: { color: colors.textPlaceholder, fontWeight: fontWeight.regular, fontSize: fontSize.sm },

    tabRow: {
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        flexGrow: 0,
        flexShrink: 0,
    },
    tabRowContent: {
        flexDirection: 'row',
        gap: spacing.md,
        paddingLeft: spacing['2xl'],
        paddingRight: spacing['4xl'],
        paddingVertical: spacing.lg,
    },
    tabChip: {
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    tabChipActive: { backgroundColor: colors.primary },
    tabChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    tabChipTextActive: { color: colors.textWhite },

    standingsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: 11,
    },
    standingsRowMe: { backgroundColor: palette.orange50 },
    standingsHeader: { borderBottomWidth: 1, borderBottomColor: colors.borderLight, paddingVertical: spacing.md },
    standingsHeaderText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textPlaceholder },
    standingsRank: { width: 24, fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textSecondary },
    standingsTeam: { flex: 1, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    standingsCell: { width: 32, textAlign: 'center', fontSize: fontSize.md, color: colors.textSecondary },
    standingsPts: { width: 64, textAlign: 'center', fontSize: fontSize.sm, color: colors.textSecondary },
    standingsMe: { color: colors.primary, fontWeight: fontWeight.bold },

    waiverRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: 11,
    },
    waiverHeader: { borderBottomWidth: 1, borderBottomColor: colors.borderLight, paddingVertical: spacing.md },
    waiverRank: { width: 32, fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textSecondary },
    waiverTeam: { flex: 1, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    waiverName: { width: 110, textAlign: 'right', fontSize: fontSize.sm, color: colors.textMuted },

    txRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
    },
    txRowMe: { backgroundColor: palette.orange50 },
    txInfo: { flex: 1, gap: spacing.xxs },
    txNameRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
    txPlayer: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    txTeam: { fontSize: 12, color: colors.textMuted },
    txRight: { alignItems: 'flex-end', gap: spacing.xs },
    txTime: { fontSize: fontSize.xs, color: colors.textPlaceholder },

    picksBankHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    picksBankHeaderFrom: { flex: 1, marginLeft: spacing.lg },
    picksBankHeaderOwner: { width: 110, textAlign: 'right' },
    picksBankRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
    },
    picksBankRound: { width: 36, fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textSecondary },
    picksBankFrom: { flex: 1, fontSize: fontSize.sm, color: colors.textSecondary, marginLeft: spacing.lg },
    picksBankOwner: { width: 110, textAlign: 'right', fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textPrimary },
})

const StandingsListHeader = (
    <View style={[styles.standingsRow, styles.standingsHeader]}>
        <Text style={[styles.standingsRank, styles.standingsHeaderText]}>#</Text>
        <Text style={[styles.standingsTeam, styles.standingsHeaderText]}>Team</Text>
        <Text style={[styles.standingsCell, styles.standingsHeaderText]}>W</Text>
        <Text style={[styles.standingsCell, styles.standingsHeaderText]}>L</Text>
        <Text style={[styles.standingsPts, styles.standingsHeaderText]}>PF</Text>
        <Text style={[styles.standingsPts, styles.standingsHeaderText]}>MAX PF</Text>
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
