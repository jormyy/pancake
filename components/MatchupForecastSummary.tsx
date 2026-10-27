import { StyleSheet, Text, View } from 'react-native'
import type { MatchupForecast } from '@/hooks/use-matchup-forecast'
import { colors, spacing, textStyles } from '@/constants/tokens'

export function MatchupForecastSummary({ forecast, myMemberId, opponentMemberId }: {
    forecast: MatchupForecast | null
    pending: boolean
    stale: boolean
    error: boolean
    myMemberId: string
    opponentMemberId: string
}) {
    const teams = [myMemberId, opponentMemberId].map(memberId => forecast?.teams.find(team => team.memberId === memberId))
    const complete = teams.every(team => team?.projectedFinal != null && Number.isFinite(team.projectedFinal))
    return <View style={styles.summary} testID="matchup-forecast">
        {teams.map((team, index) => <View key={index} style={[styles.team, index === 1 && styles.right]}>
            <Text style={styles.value} numberOfLines={1}>
                {team?.projectedFinal == null || !Number.isFinite(team.projectedFinal) ? '— proj' : `${Math.round(team.projectedFinal)} proj`}
                {' · '}
                {complete && team?.winProbability != null && Number.isFinite(team.winProbability) ? `${Math.round(team.winProbability * 100)}% win` : '— win'}
            </Text>
        </View>)}
    </View>
}

const styles = StyleSheet.create({
    summary: { flexDirection: 'row', paddingHorizontal: spacing.md, paddingBottom: spacing.md, gap: spacing.md },
    team: { flex: 1, minWidth: 0 },
    right: { alignItems: 'flex-end' },
    value: { ...textStyles.meta, color: colors.primaryDark, fontVariant: ['tabular-nums'] },
})
