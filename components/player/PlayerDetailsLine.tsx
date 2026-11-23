import { StyleSheet, Text } from 'react-native'
import { TeamLogo } from '@/components/TeamLogo'
import { colors, componentTokens } from '@/constants/tokens'

/** "[logo] LAL · PG, SG · #15", skipping whatever is unknown. Shared by player rows and the player page. */
export function PlayerDetailsLine({ team, positions, jersey }: { team?: string | null; positions: readonly string[]; jersey?: string | null }) {
    const details = [team, positions.join(', '), jersey ? `#${jersey}` : null].filter(Boolean).join(' · ')
    return <>
        {team ? <TeamLogo key={team} team={team} size={styles.details.lineHeight} fallback={false} /> : null}
        {details ? <Text style={styles.details} numberOfLines={1}>{details}</Text> : null}
    </>
}

const styles = StyleSheet.create({
    details: { ...componentTokens.playerRow.metadata, color: colors.textSecondary, flexShrink: 1, minWidth: 0 },
})
