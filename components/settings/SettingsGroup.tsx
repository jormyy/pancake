import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { Children, Fragment, isValidElement, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, motion, radii, spacing, textStyles } from '@/constants/tokens'

type PressableState = { hovered?: boolean; pressed?: boolean }

/**
 * A titled card of settings rows, like iOS Settings. Rows are separated
 * automatically, so screens only list them.
 */
export function SettingsGroup({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
    const rows = Children.toArray(children).filter(isValidElement)
    return (
        <View style={styles.group}>
            {title ? (
                <Text style={[textStyles.sectionLabel, styles.groupTitle]} role="heading" aria-level={2} accessibilityRole="header">
                    {title}
                </Text>
            ) : null}
            <View style={styles.card}>
                {rows.map((row, index) => (
                    <Fragment key={row.key ?? index}>
                        {index > 0 ? <View style={styles.divider} /> : null}
                        {row}
                    </Fragment>
                ))}
            </View>
            {footer ? <Text style={[textStyles.meta, styles.groupFooter]}>{footer}</Text> : null}
        </View>
    )
}

/**
 * One settings line: a label, an optional value or control on the right, and
 * a chevron when the row opens something.
 */
export function SettingsRow({
    label,
    detail,
    value,
    accessory,
    onPress,
    disabled = false,
    tone = 'default',
    chevron,
    role = 'button',
    checked,
    accessibilityLabel,
}: {
    label: string
    detail?: string
    value?: string | null
    accessory?: ReactNode
    onPress?: () => void
    disabled?: boolean
    tone?: 'default' | 'danger'
    chevron?: boolean
    role?: 'button' | 'switch'
    checked?: boolean
    accessibilityLabel?: string
}) {
    const showChevron = chevron ?? (onPress != null && role === 'button' && accessory == null)
    const content = (
        <>
            <View style={styles.labelBlock}>
                <Text style={[textStyles.rowTitle, tone === 'danger' && styles.danger]} numberOfLines={2}>{label}</Text>
                {detail ? <Text style={textStyles.meta}>{detail}</Text> : null}
            </View>
            {value != null ? <Text style={[textStyles.body, styles.value]} numberOfLines={1}>{value}</Text> : null}
            {accessory}
            {showChevron ? <MaterialIcons name="chevron-right" size={20} color={colors.textMuted} /> : null}
        </>
    )
    if (!onPress) {
        return <View style={styles.row} accessibilityLabel={accessibilityLabel}>{content}</View>
    }
    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            role={role}
            aria-checked={role === 'switch' ? checked : undefined}
            accessibilityRole={role}
            accessibilityLabel={accessibilityLabel ?? label}
            accessibilityState={{ disabled, ...(role === 'switch' ? { checked } : null) }}
            style={({ hovered, pressed }: PressableState) => [
                styles.row,
                hovered && styles.rowHover,
                pressed && styles.rowPressed,
                disabled && styles.rowDisabled,
            ]}
        >
            {content}
        </Pressable>
    )
}

/** On/off control drawn inside a SettingsRow with role="switch". */
export function SettingsToggle({ on }: { on: boolean }) {
    return (
        <View style={[styles.toggle, on && styles.toggleOn]} aria-hidden>
            <View style={[styles.toggleKnob, on && styles.toggleKnobOn]} />
        </View>
    )
}

const styles = StyleSheet.create({
    group: { gap: spacing.sm },
    groupTitle: { paddingHorizontal: spacing.xs },
    groupFooter: { paddingHorizontal: spacing.xs },
    card: {
        backgroundColor: colors.bgCard,
        borderRadius: radii.lg,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: colors.borderLight,
        overflow: 'hidden',
    },
    divider: { height: 1, backgroundColor: colors.separator, marginLeft: spacing.lg },
    row: {
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
    },
    rowHover: { backgroundColor: colors.bgSubtle },
    rowPressed: { opacity: motion.pressedOpacity },
    rowDisabled: { opacity: 0.5 },
    labelBlock: { flex: 1, minWidth: 0, gap: spacing.xxs },
    value: { flexShrink: 1, textAlign: 'right', color: colors.textSecondary },
    danger: { color: colors.dangerDark },
    toggle: {
        width: 44,
        height: 26,
        borderRadius: radii.full,
        backgroundColor: colors.bgMuted,
        borderWidth: 1,
        borderColor: colors.borderLight,
        justifyContent: 'center',
        paddingHorizontal: spacing.xxs,
    },
    toggleOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    toggleKnob: { width: 20, height: 20, borderRadius: radii.full, backgroundColor: colors.bgCard },
    toggleKnobOn: { alignSelf: 'flex-end' },
})
