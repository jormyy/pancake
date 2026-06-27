import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { useState } from 'react'
import { getPlayerTransactionHistory } from '@/lib/players'
import type { TransactionHistoryEntry } from '@/lib/players'
import { colors, fontSize, fontWeight, spacing, radii } from '@/constants/tokens'

const PAGE_SIZE = 20

function fmtDate(dateStr: string): string {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

type Props = {
    playerId: string
    leagueId: string
    transactions: TransactionHistoryEntry[]
}

export function TransactionHistory({ playerId, leagueId, transactions: initial }: Props) {
    const [transactions, setTransactions] = useState(initial)
    const [hasMore, setHasMore] = useState(initial.length === PAGE_SIZE)
    const [loading, setLoading] = useState(false)

    async function loadMore() {
        if (loading) return
        setLoading(true)
        try {
            const next = await getPlayerTransactionHistory(playerId, leagueId, PAGE_SIZE, transactions.length)
            setTransactions((prev) => [...prev, ...next])
            setHasMore(next.length === PAGE_SIZE)
        } catch (e) {
            console.error(e)
        } finally {
            setLoading(false)
        }
    }

    if (transactions.length === 0) {
        return (
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>League History</Text>
                <Text style={styles.noData}>No transactions yet.</Text>
            </View>
        )
    }

    return (
        <View style={styles.section}>
            <Text style={styles.sectionTitle}>League History</Text>
            {transactions.map((tx) => (
                <View key={tx.id} style={styles.row}>
                    <View style={styles.left}>
                        <Text style={styles.label}>{tx.label}</Text>
                        <Text style={styles.team}>{tx.teamName}</Text>
                    </View>
                    <Text style={styles.date}>{fmtDate(tx.occurredAt)}</Text>
                </View>
            ))}
            {hasMore && (
                <Pressable style={styles.loadMore} onPress={loadMore} disabled={loading}>
                    {loading
                        ? <ActivityIndicator size="small" color={colors.primary} />
                        : <Text style={styles.loadMoreText}>Load More</Text>}
                </Pressable>
            )}
        </View>
    )
}

const styles = StyleSheet.create({
    section: { gap: spacing.md },
    sectionTitle: { fontSize: 17, fontWeight: fontWeight.bold, color: colors.textPrimary },
    noData: { color: colors.textPlaceholder, fontSize: fontSize.md },

    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    left: { gap: spacing.xxs },
    label: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    team: { fontSize: 12, color: colors.textMuted },
    date: { fontSize: 12, color: colors.textPlaceholder },

    loadMore: {
        alignItems: 'center',
        paddingVertical: spacing.lg,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
    },
    loadMoreText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.primaryDark },
})
