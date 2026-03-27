import { View, Text, StyleSheet } from 'react-native'
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
    section: { gap: 8 },
    sectionTitle: { fontSize: 17, fontWeight: '700', color: '#111' },
    noData: { color: '#aaa', fontSize: 14 },

    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: '#f3f3f3',
    },
    left: { gap: 2 },
    label: { fontSize: 14, fontWeight: '600', color: '#111' },
    team: { fontSize: 12, color: '#888' },
    date: { fontSize: 12, color: '#aaa' },
})
