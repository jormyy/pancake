import type { ComponentProps } from 'react'
import { View, StyleSheet } from 'react-native'
import { borderWidth, colors, componentTokens } from '@/constants/tokens'

type Props = ComponentProps<typeof View> & { interactive?: boolean }

export function ListHeader({ children, interactive = false, style, ...props }: Props) {
    return <View {...props} style={[styles.row, interactive && styles.interactive, style]}>{children}</View>
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: componentTokens.listHeader.minHeight,
        paddingHorizontal: componentTokens.listHeader.paddingHorizontal,
        backgroundColor: componentTokens.listHeader.backgroundColor,
        borderBottomWidth: borderWidth.thin,
        borderBottomColor: colors.borderLight,
    },
    interactive: { minHeight: componentTokens.segmentedControl.minHeight },
})
