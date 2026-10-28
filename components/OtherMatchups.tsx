import { ScrollView, StyleSheet, Text, Pressable, View } from 'react-native'
import type { LeagueWeekMatchup } from '@/lib/scoring'
import { formatPoints } from '@/lib/format'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

export function OtherMatchups({ matchups, onOpen }: { matchups: LeagueWeekMatchup[]; onOpen: (id: string) => void }) {
    const others = matchups.filter(matchup => !matchup.isMine)
    if (!others.length) return null
    return (
        <View style={styles.strip} testID="other-matchups">
            <Text style={styles.heading} accessibilityRole="header">Other matchups</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.entries}>
                {others.map(matchup => (
                    <Pressable key={matchup.id} accessibilityRole="button"
                        accessibilityLabel={`Open ${matchup.homeTeamName} versus ${matchup.awayTeamName}`}
                        onPress={() => onOpen(matchup.id)} style={styles.entry}>
                        <View style={styles.team}><Text style={styles.name} numberOfLines={1}>{matchup.homeTeamName}</Text><Text style={styles.score}>{formatPoints(matchup.homePoints)}</Text></View>
                        <View style={styles.team}><Text style={styles.name} numberOfLines={1}>{matchup.awayTeamName}</Text><Text style={styles.score}>{formatPoints(matchup.awayPoints)}</Text></View>
                    </Pressable>
                ))}
            </ScrollView>
        </View>
    )
}

const styles = StyleSheet.create({
    strip: { marginVertical: spacing.md, gap: spacing.sm },
    heading: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textMuted },
    entries: { gap: spacing.sm },
    entry: { width: 220, padding: spacing.md, gap: spacing.sm, backgroundColor: colors.bgCard, borderRadius: radii.lg },
    team: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    name: { flex: 1, fontSize: fontSize.sm, color: colors.textPrimary },
    score: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textPrimary },
})
