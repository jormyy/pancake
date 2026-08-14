import { View, Text, StyleSheet, Platform } from 'react-native'
import { WeekDay } from '@/lib/lineup'
import { todayET } from '@/lib/shared/dates'
import { colors, fontSize, fontWeight, radii, spacing, tints, uiColors } from '@/constants/tokens'
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
}: {
    days: WeekDay[]
    selectedDate: string
    onSelect: (date: string) => void
    compact?: boolean
}) {
    return (
        <View style={[styles.row, styles.content, compact && styles.contentCompact]}>
            {days.map((day) => {
                const isSelected = day.date === selectedDate
                const isPast = day.date < todayET()
                const isFuture = !day.isToday && !isPast
                return (
                    <MotionPressable
                        key={day.date}
                        style={[
                            styles.cell,
                            compact && styles.cellCompact,
                            isSelected && styles.cellSelected,
                            day.isToday && !isSelected && styles.cellToday,
                            !day.hasGames && styles.cellNoGames,
                        ]}
                        onPress={() => onSelect(day.date)}
                        accessibilityRole="button"
                        accessibilityLabel={accessibleDayLabel(day)}
                        accessibilityState={{ selected: isSelected }}
                        {...(isSelected ? ARIA_CURRENT_DATE : undefined)}
                        hitSlop={4}
                        pressedScale={0.92}
                    >
                        <Text style={[styles.label, compact && styles.labelCompact, isSelected && styles.labelSelected, !day.hasGames && styles.labelFaint]}>
                            {day.dayLabel}
                        </Text>
                        <Text style={[styles.num, compact && styles.numCompact, isSelected && styles.numSelected, !day.hasGames && styles.numFaint]}>
                            {day.dateNum}
                        </Text>
                        {day.hasGames && day.isToday && (
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
    row: { borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    content: { flexDirection: 'row', justifyContent: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.lg - spacing.xxs, gap: spacing.sm },
    contentCompact: { paddingVertical: spacing.xs - 1, gap: spacing.xs - 1 },
    cell: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.sm, borderRadius: radii.lg, borderCurve: 'continuous' as const, gap: spacing.xxs },
    // flexBasis + shrink (not a fixed width) so all 7 cells fit 320px screens.
    cellCompact: { flexGrow: 0, flexShrink: 1, flexBasis: 40, minWidth: 34, minHeight: 36, paddingVertical: spacing.xs - 1, gap: 0, borderRadius: radii.md + 1 },
    cellSelected: { backgroundColor: colors.primary },
    cellToday: { backgroundColor: colors.primaryLight },
    cellNoGames: { opacity: 0.4 },
    label: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textMuted },
    labelCompact: { fontSize: fontSize['2xs'], lineHeight: fontSize.xs },
    labelSelected: { color: colors.textWhite },
    labelFaint: { color: uiColors.textFaint },
    num: { fontSize: fontSize.md + 1, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    numCompact: { fontSize: fontSize.md, lineHeight: fontSize.lg },
    numSelected: { color: colors.textWhite },
    numFaint: { color: uiColors.textFaint },
    dot: { width: 5, height: 5, borderRadius: 3, borderCurve: 'continuous' as const, backgroundColor: colors.primary, marginTop: 1 },
    dotSelected: { backgroundColor: tints.selectedIndicatorStrong },
    dash: { width: spacing.lg, height: spacing.xxs, borderRadius: 1, backgroundColor: colors.border, marginTop: spacing.xs - 1 },
    dashSelected: { backgroundColor: tints.selectedIndicatorMuted },
    indicatorSpacer: { height: 5, marginTop: 1 },
})
