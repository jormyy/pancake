import { ScrollView, Text, Pressable, StyleSheet } from 'react-native'

function seasonLabel(year: number): string {
    return `${year - 1}–${String(year).slice(2)}`
}

type Props = {
    seasons: number[]
    selectedSeason: number
    onSelect: (season: number) => void
}

export function SeasonSelector({ seasons, selectedSeason, onSelect }: Props) {
    if (seasons.length <= 1) return null

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.row}
            style={styles.scroll}
        >
            {seasons.map((year) => {
                const active = year === selectedSeason
                return (
                    <Pressable
                        key={year}
                        style={[styles.pill, active && styles.pillActive]}
                        onPress={() => onSelect(year)}
                    >
                        <Text style={[styles.pillText, active && styles.pillTextActive]}>
                            {seasonLabel(year)}
                        </Text>
                    </Pressable>
                )
            })}
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    scroll: { marginHorizontal: -20 },
    row: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingVertical: 2 },
    pill: {
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderRadius: 20,
        borderCurve: 'continuous' as const,
        backgroundColor: '#f3f3f3',
    },
    pillActive: { backgroundColor: '#F97316' },
    pillText: { fontSize: 13, fontWeight: '600', color: '#333' },
    pillTextActive: { color: '#fff' },
})
