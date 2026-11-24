import { StyleSheet } from 'react-native'
import { colors, fontSize, fontWeight } from '@/constants/tokens'

export const tableStyles = StyleSheet.create({
    rowMe: { backgroundColor: colors.primaryLight },
    textMe: { color: colors.primaryDark, fontWeight: fontWeight.bold },
    headerText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textPlaceholder },
})
