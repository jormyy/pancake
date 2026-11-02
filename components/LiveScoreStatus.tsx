import { Text } from 'react-native'
import { spacing, textStyles } from '@/constants/tokens'

export function LiveScoreStatus({ delayed }: { delayed: boolean }) {
    return delayed ? <Text testID="live-score-delayed" accessibilityRole="text" style={[textStyles.meta,{paddingHorizontal:spacing.md,paddingVertical:spacing.sm}]}>Live scores delayed. Showing saved scores.</Text> : null
}
