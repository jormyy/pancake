import { ReactNode } from 'react'
import { Platform, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { ScreenFrame } from '@/components/ui/ScreenFrame'
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
        <ScreenFrame style={[styles.container, containerStyle]}>
            <ScrollView
                style={styles.scroller}
                contentContainerStyle={styles.fullScreenContent}
                keyboardShouldPersistTaps="handled"
            >
                {card}
            </ScrollView>
        </ScreenFrame>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bgScreen,
    },
    scroller: {
        flex: 1,
    },
    fullScreenContent: {
        flexGrow: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing.lg,
    },
    inner: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: spacing.lg,
        gap: spacing.md,
    },
    card: {
        alignItems: 'center',
        gap: spacing.md,
        width: '100%',
        paddingVertical: spacing.xl,
        paddingHorizontal: spacing.xl,
        borderRadius: radii['2xl'],
        borderCurve: 'continuous',
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        ...(Platform.OS === 'web' ? { boxShadow: shadows.md } : {}),
    } as WebOnlyViewStyle,
})
