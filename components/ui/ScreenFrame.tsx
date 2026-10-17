import type { ReactNode } from 'react'
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native'
import { SafeAreaView, type Edges } from 'react-native-safe-area-context'

export function ScreenFrame({ children, style, edges }: {
    children: ReactNode
    style?: StyleProp<ViewStyle>
    edges?: Edges
}) {
    return Platform.OS === 'web'
        ? <View style={style}>{children}</View>
        : <SafeAreaView style={style} edges={edges}>{children}</SafeAreaView>
}
