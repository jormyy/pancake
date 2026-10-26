import { StyleSheet, Text, View } from 'react-native'
import type { MatchupForecast } from '@/hooks/use-matchup-forecast'
import { colors, spacing, textStyles } from '@/constants/tokens'

export function MatchupForecastSummary({ forecast, pending, stale, error, myMemberId, opponentMemberId }: {
    forecast: MatchupForecast | null
    pending: boolean
    stale: boolean
    error: boolean
    myMemberId: string
    opponentMemberId: string
}) {
    const updated = forecast?.calculatedAt ? new Date(forecast.calculatedAt) : null
    const time = updated && Number.isFinite(updated.getTime()) ? updated.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null
    const status = !forecast ? pending ? 'Forecast updating' : 'Forecast unavailable'
        : stale ? 'Forecast out of date' : forecast.status === 'available' ? 'Matchup forecast' : forecast.status === 'limited' ? 'Limited forecast' : 'Forecast unavailable'
    const sourceNames: Record<string, string> = { sleeper: 'Sleeper (RotoWire)', season_avg: 'Season averages', internal: 'Internal projection', fantasypros_daily: 'FantasyPros', fantasypros_weekly_total: 'FantasyPros' }
    const sources = [...new Set((forecast?.games ?? []).map(game => game.source).filter((source): source is string => !!source))].map(source => sourceNames[source] ?? source.replace(/_/g, ' ')).join(', ')
    const missing = [...new Set((forecast?.missingInputs ?? []).map(value => value.split(':')[0]))].join(' · ')
    return <View style={styles.summary} testID="matchup-forecast">
        <View style={styles.teams}>
            {[myMemberId, opponentMemberId].map((memberId, index) => {
                const team = forecast?.teams.find(value => value.memberId === memberId)
                const sourceNames: Record<string, string> = { sleeper: 'Sleeper (RotoWire)', season_avg: 'Season averages', internal: 'Internal projection', fantasypros_daily: 'FantasyPros', fantasypros_weekly_total: 'FantasyPros' }
    const sources = [...new Set((forecast?.games ?? []).map(game => game.source).filter((source): source is string => !!source))].map(source => sourceNames[source] ?? source.replace(/_/g, ' ')).join(', ')
    const missing = [...new Set((forecast?.missingInputs ?? []).map(value => value.split(':')[0]))].join(' · ')
    return <View key={memberId} style={[styles.team, index === 1 && styles.right]}>
                    <Text style={styles.value}>{team?.projectedFinal == null ? 'Projection unavailable' : `${team.projectedFinal.toFixed(1)} FP projected`}</Text>
                    <Text style={styles.value}>{team?.winProbability == null ? 'Win odds unavailable' : `${(team.winProbability * 100).toFixed(0)}% win`}</Text>
                    {team ? <Text style={styles.meta}>{team.coveredGames}/{team.remainingGames} remaining games covered</Text> : null}
                </View>
            })}
        </View>
        <Text style={styles.meta}>{status}{time ? ` · Updated ${time}` : ''}</Text>
        {forecast?.tieProbability != null && forecast.tieProbability > 0 ? <Text style={styles.meta}>{(forecast.tieProbability * 100).toFixed(0)}% tie</Text> : null}
        {forecast ? <Text style={styles.meta}>{forecast.lineupBasis}</Text> : null}
        {sources ? <Text style={styles.meta}>Sources: {sources}</Text> : null}
        {missing ? <Text style={styles.meta}>{missing}</Text> : null}
        {error ? <Text style={styles.meta}>Could not refresh the forecast.</Text> : null}
    </View>
}

const styles = StyleSheet.create({
    summary: { paddingHorizontal: spacing.md, paddingBottom: spacing.md, gap: spacing.xxs },
    teams: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.xs },
    team: { flex: 1, minWidth: 0, gap: spacing.xxs },
    right: { alignItems: 'flex-end' },
    value: { ...textStyles.meta, color: colors.primaryDark, fontVariant: ['tabular-nums'] },
    meta: { ...textStyles.meta, color: colors.textMuted },
})
