import { Pressable, Text } from 'react-native'
import { colors, spacing, textStyles } from '@/constants/tokens'
import type { TimelineFilter } from '@/lib/timeline'

export type TimelineDestination = { memberId: string; entityId?: string; filter?: TimelineFilter }

export function TimelineEntry({ memberId, entityId, filter, onOpen, label = 'What happened?' }: TimelineDestination & {
    onOpen: (destination: TimelineDestination) => void
    label?: string
}) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label}
        onPress={() => onOpen({ memberId, entityId, filter })}
        style={({ pressed }) => ({ paddingVertical: spacing.sm, paddingHorizontal: spacing.md, opacity: pressed ? 0.65 : 1, minHeight: 44, justifyContent: 'center' })}>
        <Text style={{ ...textStyles.body, color: colors.primaryDark }}>{label}</Text>
    </Pressable>
}
