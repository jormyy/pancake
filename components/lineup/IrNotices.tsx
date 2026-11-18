import { StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, textStyles } from '@/constants/tokens'
import { describeIrNotice, type IrNotice } from '@/lib/lineup/ir-notices'

export function IrNotices({ notices }: { notices: IrNotice[] }) {
    if (notices.length === 0) return null
    return <View style={styles.card} accessibilityLabel="Auto lineup roster notices">
        <Text style={styles.heading}>Roster needs your call</Text>
        {notices.map((notice) => {
            const { reason, action } = describeIrNotice(notice)
            return <View key={`${notice.playerId}:${notice.reason}`} style={styles.row}>
                <Text style={styles.player}>{notice.playerName}</Text>
                <Text style={styles.reason}>{reason}</Text>
                <Text style={styles.action}>{action}</Text>
            </View>
        })}
    </View>
}

const styles = StyleSheet.create({
    card: {
        backgroundColor: colors.bgCard,
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: colors.borderLight,
        padding: spacing.lg,
        gap: spacing.md,
    },
    heading: { ...textStyles.sectionLabel },
    row: { gap: spacing.xxs },
    player: { ...textStyles.rowTitle },
    reason: { ...textStyles.body },
    action: { ...textStyles.meta },
})
