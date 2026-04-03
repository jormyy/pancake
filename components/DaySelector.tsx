import { Pressable, View, Text, StyleSheet } from 'react-native'
import { WeekDay } from '@/lib/lineup'
import { todayDateString } from '@/lib/shared/dates'
import { colors, palette } from '@/constants/tokens'

export function DaySelector({
    days,
    selectedDate,
    onSelect,
}: {
    days: WeekDay[]
    selectedDate: string
    onSelect: (date: string) => void
}) {
    return (
        <View style={[styles.row, styles.content]}>
            {days.map((day) => {
                const isSelected = day.date === selectedDate
                const isPast = day.date < todayDateString()
                const isFuture = !day.isToday && !isPast
                return (
                    <Pressable
                        key={day.date}
                        style={[
                            styles.cell,
                            isSelected && styles.cellSelected,
                            day.isToday && !isSelected && styles.cellToday,
                            !day.hasGames && styles.cellNoGames,
                        ]}
                        onPress={() => onSelect(day.date)}
                    >
                        <Text style={[styles.label, isSelected && styles.labelSelected, !day.hasGames && styles.labelFaint]}>
                            {day.dayLabel}
                        </Text>
                        <Text style={[styles.num, isSelected && styles.numSelected, !day.hasGames && styles.numFaint]}>
                            {day.dateNum}
                        </Text>
                        {day.hasGames && day.isToday && (
                            <View style={[styles.dot, isSelected && styles.dotSelected]} />
                        )}
                        {day.hasGames && isPast && (
                            <View style={[styles.dash, isSelected && styles.dashSelected]} />
                        )}
                        {isFuture && <View style={styles.indicatorSpacer} />}
                    </Pressable>
                )
            })}
        </View>
    )
}

const styles = StyleSheet.create({
    row: { borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    content: { flexDirection: 'row', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 6 },
    cell: { width: 40, alignItems: 'center', paddingVertical: 6, borderRadius: 10, borderCurve: 'continuous' as const, gap: 2 },
    cellSelected: { backgroundColor: colors.primary },
    cellToday: { backgroundColor: colors.primaryLight },
    cellNoGames: { opacity: 0.4 },
    label: { fontSize: 11, fontWeight: '700', color: colors.textMuted },
    labelSelected: { color: colors.textWhite },
    labelFaint: { color: palette.gray500 },
    num: { fontSize: 15, fontWeight: '800', color: colors.textPrimary },
    numSelected: { color: colors.textWhite },
    numFaint: { color: palette.gray500 },
    dot: { width: 5, height: 5, borderRadius: 3, borderCurve: 'continuous' as const, backgroundColor: colors.primary, marginTop: 1 },
    dotSelected: { backgroundColor: 'rgba(255,255,255,0.7)' },
    dash: { width: 12, height: 2, borderRadius: 1, backgroundColor: colors.border, marginTop: 3 },
    dashSelected: { backgroundColor: 'rgba(255,255,255,0.5)' },
    indicatorSpacer: { height: 5, marginTop: 1 },
})
