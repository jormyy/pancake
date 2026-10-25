import { useContext } from 'react'
import { StyleSheet, View } from 'react-native'
import { isTaxiEligible } from '@pancake/core'
import { Badge } from '@/components/Badge'
import { PlayerEligibilityContext } from '@/contexts/player-eligibility-context'
import { colors, spacing, textStyles } from '@/constants/tokens'

export function PlayerEligibilityTags({ yearsExp, careerGames }: { yearsExp?: number | null; careerGames?: number | null }) {
    const taxiSlots = useContext(PlayerEligibilityContext)
    return <View style={styles.tags} testID="player-eligibility-tags">
        {yearsExp === 0 ? <Badge inline label="Rookie" color={colors.textMuted} /> : null}
        {taxiSlots > 0 && isTaxiEligible(yearsExp ?? null, careerGames ?? null) ? <Badge inline label="Taxi" color={colors.primaryDark} /> : null}
    </View>
}

const styles = StyleSheet.create({
    tags: { flexDirection: 'row', alignItems: 'center', gap: spacing.xxs, height: textStyles.rowTitle.lineHeight, flexShrink: 0, overflow: 'hidden' },
})
