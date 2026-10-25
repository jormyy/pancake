import type { ReactNode } from 'react'
import { View, Text, StyleSheet, type StyleProp, type TextStyle } from 'react-native'
import { INJURY_COLORS, colors, spacing, textStyles } from '@/constants/tokens'
import { Badge } from '@/components/Badge'
import { PlayerEligibilityTags } from './PlayerEligibilityTags'

export function PlayerNameLine({ name, yearsExp, careerGames, injuryStatus, textStyle, children }: {
    name: string
    children?: ReactNode
    yearsExp?: number | null
    careerGames?: number | null
    injuryStatus?: string | null
    textStyle?: StyleProp<TextStyle>
}) {
    return <View style={styles.line} testID="player-name-line">
        <Text style={[styles.name, textStyle, styles.truncate]} numberOfLines={1}>{name}</Text>
        {injuryStatus ? <Badge inline label={injuryStatus} color={INJURY_COLORS[injuryStatus] ?? colors.textMuted} variant="solid" /> : null}
        <PlayerEligibilityTags yearsExp={yearsExp} careerGames={careerGames} />
        {children}
    </View>
}

const styles = StyleSheet.create({
    line: { flexDirection: 'row', alignItems: 'center', gap: spacing.xxs, minWidth: 0, flexShrink: 1, height: textStyles.rowTitle.lineHeight },
    name: { ...textStyles.rowTitle },
    truncate: { flexShrink: 1, minWidth: 0, lineHeight: textStyles.rowTitle.lineHeight },
})
