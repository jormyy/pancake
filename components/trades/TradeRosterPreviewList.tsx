import { Text, View } from 'react-native'
import type { TradeRosterPreview } from '@/lib/trades'
import { colors, spacing, textStyles } from '@/constants/tokens'

export function TradeRosterPreviewList({ teams }: { teams: TradeRosterPreview[] }) {
    return <View style={{ gap: spacing.lg }}>
        <Text style={textStyles.sectionLabel}>Resulting rosters</Text>
        {teams.map((team) => <View key={team.memberId} style={{ gap: spacing.sm }}>
            <Text style={textStyles.body}>{team.teamName}</Text>
            {(['active', 'ir', 'taxi'] as const).map((location) => {
                const players = team.roster.filter((player) => player.location === location)
                return <View key={location}>
                    <Text style={textStyles.meta}>{location === 'active' ? 'Regular' : location === 'ir' ? 'IR' : 'Taxi'}: {players.length}/{team.limits[location]}</Text>
                    <Text style={textStyles.body}>{players.map((player) => player.name).join(', ') || 'None'}</Text>
                </View>
            })}
            {team.drops.length ? <Text style={{ ...textStyles.body, color: colors.dangerDark }}>Drop at settlement: {team.drops.map((player) => player.name).join(', ')}</Text> : null}
            {team.error ? <Text style={{ ...textStyles.body, color: colors.dangerDark }}>{team.error}</Text> : null}
        </View>)}
    </View>
}
