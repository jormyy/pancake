import { useState } from 'react'
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors, fontSize, fontWeight, radii, shadows, spacing, tints } from '@/constants/tokens'

export type FilterOption<T extends string> = { key: T; label: string }

/** Labeled dropdown filter — opens a centered option sheet. */
export function FilterSelect<T extends string>({
    label,
    value,
    options,
    onChange,
}: {
    label: string
    value: T
    options: readonly FilterOption<T>[]
    onChange: (value: T) => void
}) {
    const [open, setOpen] = useState(false)
    const current = options.find((option) => option.key === value) ?? options[0]

    return (
        <View style={styles.filterSelectWrap}>
            <Text style={styles.filterSelectLabel}>{label}</Text>
            <Pressable
                style={styles.filterSelectButton}
                onPress={() => setOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={`${label}: ${current.label}`}
            >
                <Text style={styles.filterSelectValue} numberOfLines={1}>{current.label}</Text>
                <Text style={styles.filterSelectCaret}>▾</Text>
            </Pressable>
            <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
                <Pressable style={styles.selectBackdrop} onPress={() => setOpen(false)}>
                    <View style={styles.selectSheet} onStartShouldSetResponder={() => true}>
                        <Text style={styles.selectTitle}>{label}</Text>
                        <ScrollView>
                            {options.map((option) => {
                                const active = option.key === value
                                return (
                                    <Pressable
                                        key={option.key}
                                        style={[styles.selectOption, active && styles.selectOptionActive]}
                                        onPress={() => {
                                            onChange(option.key)
                                            setOpen(false)
                                        }}
                                    >
                                        <Text style={[styles.selectOptionText, active && styles.selectOptionTextActive]}>
                                            {option.label}
                                        </Text>
                                    </Pressable>
                                )
                            })}
                        </ScrollView>
                    </View>
                </Pressable>
            </Modal>
        </View>
    )
}

export function MultiSelect<T extends string>({
    label,
    options,
    selected,
    onChange,
    pluralLabel = 'selected',
    clearAccessibilityLabel,
}: {
    label: string
    options: readonly FilterOption<T>[]
    selected: T[]
    onChange: (values: T[]) => void
    pluralLabel?: string
    clearAccessibilityLabel?: string
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
        <View style={styles.filterSelectWrap}>
            <Text style={styles.filterSelectLabel}>{label}</Text>
            <Pressable
                style={styles.filterSelectButton}
                onPress={() => setOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={`${label}: ${summary}`}
            >
                <Text style={styles.filterSelectValue} numberOfLines={1}>{summary}</Text>
                <Text style={styles.filterSelectCaret}>▾</Text>
            </Pressable>
            <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
                <Pressable style={styles.selectBackdrop} onPress={() => setOpen(false)}>
                    <View style={styles.selectSheet} onStartShouldSetResponder={() => true}>
                        <View style={styles.multiHeader}>
                            <Text style={styles.selectTitle}>{label}</Text>
                            {selected.length > 0 ? (
                                <Pressable
                                    onPress={() => onChange([])}
                                    accessibilityRole="button"
                                    accessibilityLabel={clearAccessibilityLabel ?? `Clear ${label}`}
                                >
                                    <Text style={styles.multiClear}>Clear</Text>
                                </Pressable>
                            ) : null}
                        </View>
                        <ScrollView>
                            <View style={styles.multiGrid}>
                                {options.map((option) => {
                                    const active = selected.includes(option.key)
                                    return (
                                        <Pressable
                                            key={option.key}
                                            style={[styles.multiChip, active && styles.multiChipActive]}
                                            onPress={() => toggle(option.key)}
                                            accessibilityRole="checkbox"
                                            accessibilityState={{ checked: active }}
                                            accessibilityLabel={option.label}
                                        >
                                            <Text style={[styles.multiChipText, active && styles.multiChipTextActive]}>{option.label}</Text>
                                        </Pressable>
                                    )
                                })}
                            </View>
                        </ScrollView>
                        <Pressable style={styles.multiDone} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Done">
                            <Text style={styles.multiDoneText}>Done</Text>
                        </Pressable>
                    </View>
                </Pressable>
            </Modal>
        </View>
    )
}

const styles = StyleSheet.create({
    filterSelectWrap: {
        minWidth: 142,
        flexGrow: 1,
        flexBasis: 142,
        gap: spacing.xs,
    },
    filterSelectLabel: {
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.extrabold,
        color: colors.textMuted,
        letterSpacing: 0.8,
        textTransform: 'uppercase' as const,
    },
    filterSelectButton: {
        minHeight: 38,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.md,
        backgroundColor: colors.bgMuted,
        paddingHorizontal: spacing.md,
    },
    filterSelectValue: {
        flex: 1,
        minWidth: 0,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    filterSelectCaret: {
        flexShrink: 0,
        fontSize: fontSize.xs,
        color: colors.textMuted,
    },
    selectBackdrop: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing.xl,
        backgroundColor: tints.selectBackdrop,
    },
    selectSheet: {
        width: '100%',
        maxWidth: 360,
        maxHeight: 460,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.lg,
        backgroundColor: colors.bgCard,
        padding: spacing.md,
        ...(Platform.OS === 'web' ? { boxShadow: shadows.lg } : {}),
    },
    selectTitle: {
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.sm,
        fontSize: fontSize.md,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    multiHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    multiClear: {
        paddingHorizontal: spacing.sm,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.danger,
    },
    multiGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
        padding: spacing.sm,
    },
    multiChip: {
        minWidth: 52,
        minHeight: 36,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgMuted,
    },
    multiChipActive: {
        backgroundColor: colors.primaryLight,
        borderColor: colors.primaryBorder,
    },
    multiChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textSecondary },
    multiChipTextActive: { color: colors.primaryDark },
    multiDone: {
        marginTop: spacing.sm,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        backgroundColor: colors.primary,
    },
    multiDoneText: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textWhite },
    selectOption: {
        minHeight: 42,
        justifyContent: 'center',
        borderRadius: radii.md,
        paddingHorizontal: spacing.md,
    },
    selectOptionActive: {
        backgroundColor: colors.primaryLight,
    },
    selectOptionText: {
        fontSize: fontSize.md,
        fontWeight: fontWeight.semibold,
        color: colors.textSecondary,
    },
    selectOptionTextActive: {
        color: colors.primaryDark,
    },
})
