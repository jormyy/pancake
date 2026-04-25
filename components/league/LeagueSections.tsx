import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useMemo } from 'react'
import { FlashList } from '@shopify/flash-list'
import { StandingRow } from '@/lib/scoring'
import { WaiverPriorityRow } from '@/lib/waivers'
import { TransactionRow, TRANSACTION_LABELS } from '@/lib/transactions'
import { LeaguePickItem } from '@/lib/rookieDraft'
import { getPositionColor } from '@/constants/positions'
import { colors, palette, fontSize, fontWeight, spacing, TX_COLORS } from '@/constants/tokens'
import { playerHeadshotUrl, timeAgo } from '@/lib/format'
import { ItemSeparator } from '@/components/ItemSeparator'
import { EmptyState } from '@/components/EmptyState'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { SectionHeader } from '@/components/SectionHeader'

// Styles must be declared before any const JSX that references them
const styles = StyleSheet.create({
    standingsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: 11,
    },
    standingsRowMe: { backgroundColor: palette.maple50 },
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
    txRowMe: { backgroundColor: palette.maple50 },
    txInfo: { flex: 1, gap: spacing.xxs },
    txNameRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
    txPlayer: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    txTeam: { fontSize: 12, color: colors.textMuted },
    txRight: { alignItems: 'flex-end', gap: spacing.xs },
    txTime: { fontSize: fontSize.xs, color: colors.textPlaceholder },
    meTag: { color: colors.textPlaceholder, fontWeight: fontWeight.regular, fontSize: fontSize.sm },

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

// ── Standings ────────────────────────────────────────────────────

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

export function StandingsTable({ standings, myMemberId, onSelectTeam }: { standings: StandingRow[]; myMemberId?: string; onSelectTeam: (memberId: string, teamName: string) => void }) {
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

// ── Activity Feed ────────────────────────────────────────────────

function ActivityRow({ item, isMe }: { item: TransactionRow; isMe: boolean }) {
    const color = TX_COLORS[item.transactionType] ?? colors.textMuted
    const label = TRANSACTION_LABELS[item.transactionType] ?? item.transactionType
    return (
        <View style={[styles.txRow, isMe && styles.txRowMe]}>
            <Avatar
                name={item.playerName}
                color={getPositionColor(item.eligiblePositions[0] ?? item.position)}
                size={40}
                uri={playerHeadshotUrl(item.nbaId)}
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

export function ActivityFeed({ transactions, myMemberId }: { transactions: TransactionRow[]; myMemberId?: string }) {
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

// ── Waiver Priority ──────────────────────────────────────────────

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

const WaiverListHeader = (
    <View style={[styles.waiverRow, styles.waiverHeader]}>
        <Text style={[styles.waiverRank, styles.standingsHeaderText]}>#</Text>
        <Text style={[styles.waiverTeam, styles.standingsHeaderText]}>Team</Text>
        <Text style={[styles.waiverName, styles.standingsHeaderText]}>Manager</Text>
    </View>
)

export function WaiverPriorityList({ rows, myMemberId }: { rows: WaiverPriorityRow[]; myMemberId?: string }) {
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

// ── Picks Bank ───────────────────────────────────────────────────

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

const PicksBankListHeader = (
    <View style={styles.picksBankHeader}>
        <Text style={styles.standingsHeaderText}>ROUND</Text>
        <Text style={[styles.standingsHeaderText, styles.picksBankHeaderFrom]}>FROM</Text>
        <Text style={[styles.standingsHeaderText, styles.picksBankHeaderOwner]}>OWNER</Text>
    </View>
)

export function PicksBankList({ picks, myMemberId }: { picks: LeaguePickItem[]; myMemberId?: string }) {
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

