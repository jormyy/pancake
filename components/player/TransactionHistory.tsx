import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useRef, useState } from 'react'
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
    const resourceKey = `${leagueId}:${playerId}`
    const [resource, setResource] = useState({
        key: resourceKey,
        source: initial,
        transactions: initial,
        hasMore: initial.length === PAGE_SIZE,
        loading: false,
    })
    const activeKey = useRef(resourceKey)
    const requestToken = useRef<{ key: string; token: symbol } | null>(null)
    activeKey.current = resourceKey
    const current = resource.key === resourceKey && resource.source === initial ? resource : {
        key: resourceKey,
        source: initial,
        transactions: initial,
        hasMore: initial.length === PAGE_SIZE,
        loading: false,
    }

    async function loadMore() {
        if (current.loading || requestToken.current?.key === resourceKey) return
        const token = Symbol('transaction-history-page')
        const requestKey = resourceKey
        requestToken.current = { key: requestKey, token }
        setResource({ ...current, loading: true })
        try {
            const next = await getPlayerTransactionHistory(
                playerId,
                leagueId,
                PAGE_SIZE,
                current.transactions.length,
            )
            if (activeKey.current !== requestKey) return
            setResource((latest) => latest.key === requestKey ? {
                key: requestKey,
                source: latest.source,
                transactions: [...latest.transactions, ...next],
                hasMore: next.length === PAGE_SIZE,
                loading: false,
            } : latest)
        } catch (e) {
            if (activeKey.current === requestKey) console.error(e)
        } finally {
            if (requestToken.current?.token === token) requestToken.current = null
            if (activeKey.current === requestKey) {
                setResource((latest) => latest.key === requestKey ? { ...latest, loading: false } : latest)
            }
        }
    }

    if (current.transactions.length === 0) {
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
            {current.transactions.map((tx) => (
                <View key={tx.id} style={styles.row}>
                    <View style={styles.left}>
                        <Text style={styles.label}>{tx.label}</Text>
                        <Text style={styles.team}>{tx.teamName}</Text>
                    </View>
                    <Text style={styles.date}>{fmtDate(tx.occurredAt)}</Text>
                </View>
            ))}
            {current.hasMore && (
                <Pressable style={styles.loadMore} onPress={loadMore} disabled={current.loading}>
                    <Text style={styles.loadMoreText}>Load More</Text>
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
