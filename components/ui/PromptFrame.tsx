import { ReactNode } from 'react'
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors, radii, shadows, spacing, type WebOnlyViewStyle } from '@/constants/tokens'

type PromptFrameProps = {
    children: ReactNode
    fullScreen?: boolean
    framed?: boolean
    cardMaxWidth?: number
    containerStyle?: StyleProp<ViewStyle>
    cardStyle?: StyleProp<ViewStyle>
}

export function PromptFrame({
    children,
    fullScreen = true,
    framed,
    cardMaxWidth = 440,
    containerStyle,
    cardStyle,
}: PromptFrameProps) {
    const carded = fullScreen || framed
    const card = (
        <View style={[carded && styles.card, carded && { maxWidth: cardMaxWidth }, cardStyle]}>
            {children}
        </View>
    )

    if (!fullScreen) {
        return <View style={styles.inner}>{card}</View>
    }

    return (
        <SafeAreaView style={[styles.container, containerStyle]}>
            <View style={styles.inner}>{card}</View>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bgScreen,
    },
    inner: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing['3xl'],
        gap: spacing.md,
    },
    card: {
        alignItems: 'center',
        gap: spacing.md,
        width: '100%',
        paddingVertical: spacing['4xl'],
        paddingHorizontal: spacing['3xl'],
        borderRadius: radii['2xl'],
        borderCurve: 'continuous',
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        ...(Platform.OS === 'web' ? { boxShadow: shadows.md } : {}),
    } as WebOnlyViewStyle,
})
