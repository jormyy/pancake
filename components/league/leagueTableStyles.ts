import { StyleSheet } from 'react-native'
import { colors, fontWeight, typeScale } from '@/constants/tokens'

export const tableStyles = StyleSheet.create({
    rowMe: { backgroundColor: colors.primaryLight },
    textMe: { color: colors.primaryDark, fontWeight: fontWeight.bold },
    headerText: { ...typeScale.caption, fontWeight: fontWeight.bold, color: colors.textPlaceholder },
})
