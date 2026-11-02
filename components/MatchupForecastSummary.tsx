import { StyleSheet, Text, View } from 'react-native'
import type { MatchupForecastDisplay } from '@/hooks/use-matchup-forecast'
import { colors, radii, spacing, textStyles } from '@/constants/tokens'

export function MatchupForecastSummary({ forecast, myMemberId, opponentMemberId, error }: {
    forecast: MatchupForecastDisplay | null
    pending: boolean
    stale: boolean
    error: boolean
    myMemberId: string
    opponentMemberId: string
}) {
    const teams = [myMemberId, opponentMemberId].map(memberId => forecast?.teams.find(team => team.memberId === memberId))
    const finals = teams.map(team => Math.max(0, Number.isFinite(team?.projectedFinal) ? team!.projectedFinal! : Number.isFinite(team?.currentPoints) ? team!.currentPoints : 0))
    const total = finals[0] + finals[1]
    const probabilities = teams.map((team, index) => forecast?.tieProbability === 1 ? 0.5 : Math.max(0, Math.min(1,
        team?.winProbability != null && Number.isFinite(team.winProbability) ? team.winProbability : total > 0 ? finals[index] / total : 0.5)))
    const split = probabilities[0]
    const missing = forecast || error ? 'n/a' : 'pending'
    const projection = (index: number) => {
        const value = teams[index]?.projectedFinal
        return value != null && Number.isFinite(value) ? `${forecast?.missingInputs?.some(input => input.startsWith('Projection substituted:') && forecast.games?.some(game => game.memberId === teams[index]?.memberId && input === `Projection substituted: ${game.playerId}:${game.gameId}`)) ? '~' : ''}${Math.round(value)} proj` : missing === 'pending' ? missing : `${missing} proj`
    }
    const odds = (index: number) => forecast ? `${Math.round(probabilities[index] * 100)}% win` : missing === 'pending' ? missing : `${missing} win`
    return <View style={styles.summary} testID="matchup-forecast">
        <Text style={styles.value} numberOfLines={1} testID="matchup-projection-left">{projection(0)}</Text>
        <Text style={styles.value} numberOfLines={1} testID="matchup-odds-left">{odds(0)}</Text>
        <View style={styles.bar} testID="matchup-probability-bar" accessibilityRole="image"
            accessibilityLabel={forecast ? `Win probability: ${odds(0)} to ${odds(1)}` : `Win probability ${missing}`}>
            {forecast ? <>
                <View style={{ flex: split, backgroundColor: split >= 0.5 ? colors.success : colors.danger }} />
                <View style={{ flex: 1 - split, backgroundColor: split < 0.5 ? colors.success : colors.danger }} />
            </> : null}
        </View>
        <Text style={styles.value} numberOfLines={1} testID="matchup-odds-right">{odds(1)}</Text>
        <Text style={styles.value} numberOfLines={1} testID="matchup-projection-right">{projection(1)}</Text>
    </View>
}

const styles = StyleSheet.create({
    summary: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingBottom: spacing.md, gap: spacing.xs },
    value: { ...textStyles.meta, color: colors.primaryDark, flexShrink: 0, fontVariant: ['tabular-nums'] },
    bar: { flex: 1, minWidth: spacing.md, height: spacing.xs, flexDirection: 'row', borderRadius: radii.full, overflow: 'hidden', backgroundColor: colors.border },
})
