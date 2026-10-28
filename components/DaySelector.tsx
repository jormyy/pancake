import { View, Text, StyleSheet, Platform } from 'react-native'
import { WeekDay } from '@/lib/lineup'
import { todayET } from '@/lib/shared/dates'
import { colors, componentTokens, controlSize, fontSize, fontWeight, radii, spacing, tints, uiColors } from '@/constants/tokens'
import { MotionPressable } from '@/components/Motion'

// react-native-web forwards aria-* props to the DOM, but React Native's prop
// types don't model aria-current — spread this constant on the selected day so
// assistive tech hears the selection (accessibilityState.selected is not
// mapped to aria for role=button on web).
const ARIA_CURRENT_DATE = Platform.OS === 'web' ? ({ 'aria-current': 'date' } as const) : undefined

function accessibleDayLabel(day: WeekDay) {
    const fullDate = new Date(`${day.date}T12:00:00`).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
    })
    return day.hasGames ? fullDate : `${fullDate}, no games`
}

export function DaySelector({
    days,
    selectedDate,
    onSelect,
    compact = false,
    disabled = false,
}: {
    days: WeekDay[]
    selectedDate: string
    onSelect: (date: string) => void
    compact?: boolean
    disabled?: boolean
}) {
    const today = todayET()
    return (
        <View style={[styles.content, compact && styles.contentCompact]}>
            {days.map((day) => {
                const isSelected = day.date === selectedDate
                const isToday = day.date === today
                const isPast = day.date < today
                const isFuture = !isToday && !isPast
                return (
                    <MotionPressable
                        key={day.date}
                        style={[
                            styles.cell,
                            compact && styles.cellCompact,
                            isSelected && styles.cellSelected,
                            isToday && !isSelected && styles.cellToday,
                            !day.hasGames && styles.cellNoGames,
                        ]}
                        onPress={() => onSelect(day.date)}
                        disabled={disabled}
                        accessibilityRole="button"
                        accessibilityLabel={accessibleDayLabel(day)}
                        accessibilityState={{ selected: isSelected, disabled }}
                        {...(isSelected ? ARIA_CURRENT_DATE : undefined)}
                        hitSlop={4}
                    >
                        <Text style={[styles.label, compact && styles.labelCompact, isSelected && styles.labelSelected, !day.hasGames && styles.labelFaint]}>
                            {day.dayLabel}
                        </Text>
                        <Text style={[styles.num, compact && styles.numCompact, isSelected && styles.numSelected, !day.hasGames && styles.numFaint]}>
                            {day.dateNum}
                        </Text>
                        {day.hasGames && isToday && (
                            <View style={[styles.dot, isSelected && styles.dotSelected]} />
                        )}
                        {day.hasGames && isPast && (
                            <View style={[styles.dash, isSelected && styles.dashSelected]} />
                        )}
                        {isFuture && <View style={styles.indicatorSpacer} />}
                    </MotionPressable>
                )
            })}
        </View>
    )
}

const styles = StyleSheet.create({
    content: { flexDirection: 'row', justifyContent: 'center', ...componentTokens.daySelector.standard },
    contentCompact: { ...componentTokens.daySelector.compact },
    cell: { width: componentTokens.daySelector.target, minHeight: componentTokens.daySelector.target, alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.sm, borderRadius: radii.lg, borderCurve: 'continuous' as const, gap: spacing.xxs },
    cellCompact: { flex: 1, minWidth: 0, minHeight: controlSize.minTouch, paddingVertical: spacing.xxs, gap: spacing.none, borderRadius: radii.lg },
    cellSelected: { backgroundColor: colors.primary },
    cellToday: { backgroundColor: colors.primaryLight },
    cellNoGames: { opacity: 0.4 },
    label: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textMuted },
    labelCompact: { fontSize: fontSize['2xs'], lineHeight: fontSize.xs },
    labelSelected: { color: colors.textWhite },
    labelFaint: { color: uiColors.textFaint },
    num: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.textPrimary, fontVariant: ['tabular-nums'] as const },
    numCompact: { fontSize: fontSize.md, lineHeight: fontSize.lg },
    numSelected: { color: colors.textWhite },
    numFaint: { color: uiColors.textFaint },
    dot: { width: componentTokens.daySelector.dotSize, height: componentTokens.daySelector.dotSize, borderRadius: componentTokens.daySelector.dotRadius, borderCurve: 'continuous' as const, backgroundColor: colors.primary, marginTop: componentTokens.daySelector.indicatorOffset },
    dotSelected: { backgroundColor: tints.selectedIndicatorStrong },
    dash: { width: spacing.lg, height: spacing.xxs, borderRadius: componentTokens.daySelector.dashRadius, backgroundColor: colors.border, marginTop: spacing.xxs },
    dashSelected: { backgroundColor: tints.selectedIndicatorMuted },
    indicatorSpacer: { height: componentTokens.daySelector.dotSize, marginTop: componentTokens.daySelector.indicatorOffset },
})
