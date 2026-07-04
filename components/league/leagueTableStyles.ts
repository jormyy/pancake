import { StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight } from '@/constants/tokens'

// Row treatments shared by the standings, waiver, and picks-bank tables.
export const tableStyles = StyleSheet.create({
    rowMe: { backgroundColor: colors.primaryLight },
    textMe: { color: colors.primaryDark, fontWeight: fontWeight.bold },
    headerText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textPlaceholder },
})
