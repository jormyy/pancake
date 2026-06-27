import { ComponentProps } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { colors, fontSize, fontWeight, motion, radii, spacing } from '@/constants/tokens'

type IconName = ComponentProps<typeof MaterialIcons>['name']

type Props = {
    label: string
    selected?: boolean
    onPress?: () => void
    onRemove?: () => void
    icon?: IconName
    count?: number
    accessibilityLabel?: string
}

type PressableState = { hovered?: boolean; pressed?: boolean }

/** Selectable / removable filter chip. Selected = maple tint + border + text. */
export function Chip({ label, selected = false, onPress, onRemove, icon, count, accessibilityLabel }: Props) {
    const fg = selected ? colors.primary : colors.textSecondary

    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel ?? label}
            accessibilityState={{ selected }}
            style={({ hovered, pressed }: PressableState) => [
                styles.chip,
                selected ? styles.chipSelected : styles.chipDefault,
                hovered && !selected && styles.chipHover,
                pressed && styles.pressed,
            ]}
        >
            {icon ? <MaterialIcons name={icon} size={14} color={fg} /> : null}
            <Text style={[styles.label, { color: fg }]} numberOfLines={1}>
                {label}
            </Text>
            {typeof count === 'number' && count > 0 ? (
                <View style={[styles.countPill, selected && styles.countPillSelected]}>
                    <Text style={[styles.countText, selected && styles.countTextSelected]}>{count}</Text>
                </View>
            ) : null}
            {onRemove ? (
                <Pressable
                    onPress={onRemove}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${label}`}
                    style={styles.removeBtn}
                >
                    <MaterialIcons name="close" size={14} color={fg} />
                </Pressable>
            ) : null}
        </Pressable>
    )
}

const styles = StyleSheet.create({
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        minHeight: 34,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.full,
        borderWidth: 1,
        borderCurve: 'continuous',
    },
    chipDefault: {
        backgroundColor: colors.bgMuted,
        borderColor: colors.borderLight,
    },
    chipSelected: {
        backgroundColor: colors.primaryLight,
        borderColor: colors.primaryBorder,
    },
    chipHover: { borderColor: colors.border },
    pressed: { opacity: motion.pressedOpacity },
    label: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
    },
    countPill: {
        minWidth: 18,
        paddingHorizontal: 5,
        height: 18,
        borderRadius: radii.full,
        backgroundColor: colors.bgCard,
        alignItems: 'center',
        justifyContent: 'center',
    },
    countPillSelected: { backgroundColor: colors.primary },
    countText: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textSecondary },
    countTextSelected: { color: colors.textWhite },
    removeBtn: {
        alignItems: 'center',
        justifyContent: 'center',
    },
})
