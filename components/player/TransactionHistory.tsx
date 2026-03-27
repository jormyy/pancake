import { View, Text, StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight, spacing } from '@/constants/tokens'
import type { TransactionHistoryEntry } from '@/lib/players'

function fmtDate(dateStr: string): string {
    const d = new Date(dateStr)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

type Props = {
    transactions: TransactionHistoryEntry[]
}

export function TransactionHistory({ transactions }: Props) {
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
})
