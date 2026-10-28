import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { colors, fontSize, fontWeight, spacing, textStyles } from '@/constants/tokens'
import type { DynastyNewsItem } from '@/lib/dynasty'

export function NewsRow({ item, dateLabel }: { item: DynastyNewsItem; dateLabel: string }) {
    const open = () => {
        if (item.url) void Linking.openURL(item.url)
    }

    return (
        <Pressable
            onPress={open}
            disabled={!item.url}
            style={styles.newsRow}
            accessibilityRole={item.url ? 'link' : undefined}
            accessibilityLabel={item.title}
        >
            <View style={styles.newsTopLine}>
                <Text style={styles.newsDate}>{dateLabel}</Text>
            </View>
            <Text style={styles.newsTitle}>{item.title}</Text>
            <Text style={styles.newsSummary}>{item.summary}</Text>
            {item.playerName ? (
                <View style={styles.newsPlayerRow}>
                    <PlayerRowContent name={item.playerName} nbaId={item.playerNbaId} team={item.playerTeam} positions={item.playerPosition ? [item.playerPosition] : []} yearsExp={item.playerYearsExp} careerGames={item.playerCareerGames} injuryStatus={item.playerInjuryStatus} />
                </View>
            ) : null}
        </Pressable>
    )
}

const styles = StyleSheet.create({
    newsRow: { paddingVertical: spacing.md, paddingHorizontal: spacing.md, gap: spacing.xs },
    newsTopLine: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.lg },
    newsSource: { ...textStyles.meta, flex: 1, minWidth: 0, fontSize: fontSize.xs, fontWeight: fontWeight.extrabold, color: colors.primaryDark, textTransform: 'uppercase' },
    newsDate: { ...textStyles.meta, flexShrink: 0, fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textMuted },
    newsTitle: { ...textStyles.rowTitle },
    newsSummary: { ...textStyles.body },
    newsPlayerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
})
