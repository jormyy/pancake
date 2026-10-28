import { useContext } from 'react'
import { StyleSheet, View } from 'react-native'
import { isTaxiEligible } from '@pancake/core'
import { Badge, InjuryBadge } from '@/components/Badge'
import { PlayerEligibilityContext } from '@/contexts/player-eligibility-context'
import { compactBadgeTokens } from '@/components/ui/Badge'
import { colors, spacing } from '@/constants/tokens'

export function PlayerEligibilityTags({ yearsExp, careerGames, injuryStatus, onTaxi = false }: { yearsExp?: number | null; careerGames?: number | null; injuryStatus?: string | null; onTaxi?: boolean }) {
    const taxiSlots = useContext(PlayerEligibilityContext)
    const eligible = isTaxiEligible(yearsExp ?? null, careerGames ?? null)
    const taxiLabel = `T:${careerGames ?? '—'}`
    const taxiDescription = `${eligible ? 'Taxi eligible' : careerGames == null ? 'On taxi, eligibility unknown' : 'On taxi, no longer eligible'}, ${careerGames == null ? 'career games unknown' : `${careerGames} career regular-season games`}`
    return <View style={styles.tags} testID="player-eligibility-tags">
        <InjuryBadge status={injuryStatus} />
        {yearsExp === 0 ? <Badge size="compact" label="R" accessibilityLabel="Rookie" color={colors.textMuted} /> : null}
        {taxiSlots > 0 && (eligible || onTaxi) ? <Badge size="compact" label={taxiLabel} accessibilityLabel={taxiDescription} color={onTaxi && !eligible && careerGames != null ? colors.warningDark : colors.primaryDark} /> : null}
    </View>
}

const styles = StyleSheet.create({
    tags: { flexDirection: 'row', alignItems: 'center', gap: spacing.xxs, height: compactBadgeTokens.minHeight, flexShrink: 0, overflow: 'hidden' },
})
