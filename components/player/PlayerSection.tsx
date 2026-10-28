import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, controlSize, spacing, textStyles } from '@/constants/tokens'

export function PlayerSection({ title, expanded, onToggle, children }: { title: string; expanded: boolean; onToggle: () => void; children: ReactNode }) {
    return <View>
        <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded }} aria-expanded={expanded} onPress={onToggle} style={styles.toggle}>
            <Text style={textStyles.sectionLabel}>{title}</Text>
            <Text style={textStyles.meta}>{expanded ? 'Hide' : 'Show'}</Text>
        </Pressable>
        {expanded ? children : null}
    </View>
}

const styles = StyleSheet.create({
    toggle: { minHeight: controlSize.minTouch, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
})
