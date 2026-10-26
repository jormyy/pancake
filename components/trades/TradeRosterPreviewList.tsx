import { Text, View } from 'react-native'
import type { TradeRosterPreview } from '@/lib/trades'
import { colors, spacing, textStyles } from '@/constants/tokens'

export function TradeRosterPreviewList({ teams }: { teams: TradeRosterPreview[] }) {
    return <View style={{ gap: spacing.lg }}>
        <Text style={textStyles.sectionLabel}>Resulting rosters</Text>
        {teams.map((team) => {
            const dropsRequired = (['active', 'ir', 'taxi'] as const).reduce((total, location) =>
                total + Math.max(0, team.roster.filter(player => player.location === location).length - team.limits[location]), 0)
            return <View key={team.memberId} style={{ gap: spacing.sm }}>
            <Text style={textStyles.body}>{team.teamName}</Text>
            {(['active', 'ir', 'taxi'] as const).map((location) => {
                const players = team.roster.filter((player) => player.location === location)
                return <View key={location}>
                    <Text style={textStyles.meta}>{location === 'active' ? 'Regular' : location === 'ir' ? 'IR' : 'Taxi'}: {players.length}/{team.limits[location]}</Text>
                    <Text style={textStyles.body}>{players.map((player) => player.name).join(', ') || 'None'}</Text>
                </View>
            })}
            {dropsRequired > 0 ? <Text style={{ ...textStyles.body, color: colors.dangerDark }}>{team.teamName} must drop {dropsRequired} {dropsRequired === 1 ? 'player' : 'players'} to accept.</Text> : null}
            {team.drops.length ? <Text style={{ ...textStyles.body, color: colors.dangerDark }}>Drop at settlement: {team.drops.map((player) => player.name).join(', ')}</Text> : null}
            {team.error ? <Text style={{ ...textStyles.body, color: colors.dangerDark }}>{team.error}</Text> : null}
        </View>})}
    </View>
}
