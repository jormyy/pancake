import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
import { Sheet } from './Sheet'

export type FilterOption<T extends string> = { key: T; label: string }

type Variant = 'field' | 'chip'

type PressableState = { hovered?: boolean; pressed?: boolean }

/**
 * The control that opens a filter. `field` is a labeled select for stacked
 * forms; `chip` is a compact pill for toolbars. A chip names the filter while
 * it is at its first ("All") option and names the choice once one is set.
 */
function FilterTrigger({
    variant,
    label,
    summary,
    active,
    onPress,
}: {
    variant: Variant
    label: string
    summary: string
    active: boolean
    onPress: () => void
}) {
    if (variant === 'chip') {
        return (
            <Pressable
                style={({ hovered, pressed }: PressableState) => [
                    styles.chip,
                    active && styles.chipActive,
                    hovered && !active && styles.chipHover,
                    pressed && styles.pressed,
                ]}
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={`${label}: ${summary}`}
            >
                <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                    {active ? summary : label}
                </Text>
                <Text style={[styles.caret, active && styles.chipTextActive]}>▾</Text>
            </Pressable>
        )
    }
    return (
        <View style={styles.fieldWrap}>
            <Text style={textStyles.sectionLabel}>{label}</Text>
            <Pressable
                style={styles.fieldButton}
                onPress={onPress}
                accessibilityRole="button"
                accessibilityLabel={`${label}: ${summary}`}
            >
                <Text style={styles.fieldValue} numberOfLines={1}>{summary}</Text>
                <Text style={styles.caret}>▾</Text>
            </Pressable>
        </View>
    )
}

/** Single-choice filter. Options open in the shared Sheet. */
export function FilterSelect<T extends string>({
    label,
    value,
    options,
    onChange,
    variant = 'field',
}: {
    label: string
    value: T
    options: readonly FilterOption<T>[]
    onChange: (value: T) => void
    variant?: Variant
}) {
    const [open, setOpen] = useState(false)
    const current = options.find((option) => option.key === value) ?? options[0]

    return (
        <>
            <FilterTrigger
                variant={variant}
                label={label}
                summary={current.label}
                active={current.key !== options[0].key}
                onPress={() => setOpen(true)}
            />
            <Sheet visible={open} title={label} onClose={() => setOpen(false)}>
                <View style={styles.optionList}>
                    {options.map((option) => {
                        const selected = option.key === value
                        return (
                            <Pressable
                                key={option.key}
                                style={[styles.option, selected && styles.optionSelected]}
                                onPress={() => {
                                    onChange(option.key)
                                    setOpen(false)
                                }}
                                accessibilityRole="button"
                                accessibilityState={{ selected }}
                            >
                                <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                                    {option.label}
                                </Text>
                            </Pressable>
                        )
                    })}
                </View>
            </Sheet>
        </>
    )
}

/** Multi-choice filter. Options open in the shared Sheet as toggle chips. */
export function MultiSelect<T extends string>({
    label,
    options,
    selected,
    onChange,
    pluralLabel = 'selected',
    clearAccessibilityLabel,
    variant = 'field',
}: {
    label: string
    options: readonly FilterOption<T>[]
    selected: T[]
    onChange: (values: T[]) => void
    pluralLabel?: string
    clearAccessibilityLabel?: string
    variant?: Variant
}) {
    const [open, setOpen] = useState(false)
    const selectedLabels = options.filter((option) => selected.includes(option.key)).map((option) => option.label)
    const summary = selectedLabels.length === 0
        ? 'All'
        : selectedLabels.length === 1
            ? selectedLabels[0]
            : `${selectedLabels.length} ${pluralLabel}`
    const toggle = (key: T) =>
        onChange(selected.includes(key) ? selected.filter((value) => value !== key) : [...selected, key])

    return (
        <>
            <FilterTrigger
                variant={variant}
                label={label}
                summary={summary}
                active={selected.length > 0}
                onPress={() => setOpen(true)}
            />
            <Sheet visible={open} title={label} onClose={() => setOpen(false)}>
                <View style={styles.multiGrid}>
                    {options.map((option) => {
                        const active = selected.includes(option.key)
                        return (
                            <Pressable
                                key={option.key}
                                style={[styles.multiChip, active && styles.chipActive]}
                                onPress={() => toggle(option.key)}
                                accessibilityRole="checkbox"
                                accessibilityState={{ checked: active }}
                                accessibilityLabel={option.label}
                            >
                                <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
                            </Pressable>
                        )
                    })}
                </View>
                <View style={styles.multiActions}>
                    {selected.length > 0 ? (
                        <Pressable
                            style={styles.multiClear}
                            onPress={() => onChange([])}
                            accessibilityRole="button"
                            accessibilityLabel={clearAccessibilityLabel ?? `Clear ${label}`}
                        >
                            <Text style={styles.multiClearText}>Clear</Text>
                        </Pressable>
                    ) : null}
                    <Pressable style={styles.multiDone} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Done">
                        <Text style={styles.multiDoneText}>Done</Text>
                    </Pressable>
                </View>
            </Sheet>
        </>
    )
}

const styles = StyleSheet.create({
    pressed: { opacity: 0.76 },
    chip: {
        minHeight: 36,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.full,
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    chipHover: { backgroundColor: colors.bgSubtle },
    chipActive: { backgroundColor: colors.primaryLight, borderColor: colors.primaryBorder },
    chipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    chipTextActive: { color: colors.primaryDark },
    caret: { flexShrink: 0, fontSize: fontSize.xs, color: colors.textMuted },
    fieldWrap: { minWidth: 142, flexGrow: 1, flexBasis: 142, gap: spacing.xs },
    fieldButton: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.md,
        backgroundColor: colors.bgCard,
        paddingHorizontal: spacing.md,
    },
    fieldValue: { flex: 1, minWidth: 0, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    optionList: { gap: spacing.xxs },
    option: {
        minHeight: 44,
        justifyContent: 'center',
        borderRadius: radii.md,
        paddingHorizontal: spacing.md,
    },
    optionSelected: { backgroundColor: colors.primaryLight },
    optionText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    optionTextSelected: { color: colors.primaryDark, fontWeight: fontWeight.bold },
    multiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    multiChip: {
        minWidth: 56,
        minHeight: 40,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    multiActions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg },
    multiClear: {
        minHeight: 44,
        paddingHorizontal: spacing.xl,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    multiClearText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.dangerDark },
    multiDone: {
        flex: 1,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        backgroundColor: colors.primary,
    },
    multiDoneText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textWhite },
})
