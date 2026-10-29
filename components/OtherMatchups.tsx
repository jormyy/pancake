import { Platform, ScrollView, StyleSheet, Text, Pressable, View } from 'react-native'
import type { LeagueWeekMatchup } from '@/lib/scoring'
import { formatPoints } from '@/lib/format'
import { orderedMatchups } from '@/lib/matchup-navigation'
import { borderWidth, colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

export function OtherMatchups({ matchups, currentMatchupId, onOpen }: { matchups: LeagueWeekMatchup[]; currentMatchupId?: string; onOpen: (id: string) => void }) {
    const others = orderedMatchups(matchups)
    const selectedId = currentMatchupId ?? matchups.find(matchup => matchup.isMine)?.id
    if (!others.length) return null
    return (
        <View style={styles.strip} testID="other-matchups">
            <Text style={styles.heading} accessibilityRole="header">Other matchups</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.entries}>
                {others.map(matchup => (
                    <Pressable key={matchup.id} accessibilityRole="button"
                        accessibilityState={{ selected: matchup.id === selectedId }}
                        {...(Platform.OS === 'web' && matchup.id === selectedId ? { 'aria-current': 'true' } : {})}
                        accessibilityLabel={`Open ${matchup.homeTeamName} versus ${matchup.awayTeamName}`}
                        onPress={() => onOpen(matchup.id)} style={[styles.entry, matchup.id === selectedId && styles.selected]}>
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
    entry: { width: 220, padding: spacing.md, gap: spacing.sm, backgroundColor: colors.bgCard, borderRadius: radii.lg, borderWidth: borderWidth.thin, borderColor: colors.border },
    selected: { borderWidth: borderWidth.strong, borderColor: colors.primary },
    team: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    name: { flex: 1, fontSize: fontSize.sm, color: colors.textPrimary },
    score: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textPrimary },
})
