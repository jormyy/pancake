import { StyleSheet, Text, View } from 'react-native'
import type { SnakePick } from '@/lib/rookieDraft'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { colors, fontSize, fontWeight, spacing, table, textStyles, uiColors } from '@/constants/tokens'

export function RookiePickRow({
    item,
    myMemberId,
    nextPick,
}: {
    item: SnakePick
    myMemberId?: string
    nextPick: SnakePick | null
}) {
    const isMe = item.memberId === myMemberId
    const isSkipped = !!item.skippedAt
    const isOnClock = !item.player && !isSkipped && nextPick?.overallPick === item.overallPick

    return (
        <View
            style={[
                styles.pickRow,
                isMe && styles.pickRowMe,
                isOnClock && styles.pickRowOnClock,
            ]}
        >
            <Text style={[styles.pickNum, isMe && styles.meText]}>
                {item.overallPick}
            </Text>
            <View style={styles.pickTeam}>
                <Text style={[styles.pickTeamName, isMe && styles.meText]} numberOfLines={1}>
                    {item.teamName}
                </Text>
                {item.round > 1 && item.pickInRound === 1 ? (
                    <Text style={styles.pickRoundStart}>Round {item.round}</Text>
                ) : null}
            </View>
            {item.player ? (
                <View style={styles.pickPlayerCell}>
                    <PlayerRowContent name={item.player.displayName} nbaId={item.player.nbaId} team={item.player.nbaTeam} yearsExp={item.player.yearsExp} careerGames={item.player.careerGames} injuryStatus={item.player.injuryStatus}
                        positions={item.player.position ? [item.player.position] : []} />
                </View>
            ) : isSkipped ? (
                <Text style={styles.pickSkipped}>Skipped</Text>
            ) : (
                <Text style={[styles.pickPlayer, isOnClock && styles.onClockText]}>
                    {isOnClock ? '▶ On the clock' : '—'}
                </Text>
            )}
        </View>
    )
}

export const rookiePickRowStyles = StyleSheet.create({
    pickRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        minHeight: table.rowHeight,
        gap: spacing.md,
    },
    pickRowMe: { backgroundColor: colors.primaryLight },
    pickRowOnClock: { backgroundColor: uiColors.successSurface },
    pickNum: { width: 28, fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textMuted },
    pickTeam: { width: '25%', maxWidth: 140, minWidth: 0, gap: spacing.xxs },
    pickTeamName: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    pickRoundStart: { ...textStyles.tableHeader },
    pickPlayer: { flex: 1, fontSize: fontSize.sm, color: colors.textPlaceholder },
    pickSkipped: { flex: 1, fontSize: fontSize.sm, color: colors.textMuted, fontWeight: fontWeight.semibold },
    pickPlayerCell: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    onClockText: { color: uiColors.successText, fontWeight: fontWeight.bold },
    meText: { color: colors.primaryDark, fontWeight: fontWeight.bold }
})

const styles = rookiePickRowStyles
