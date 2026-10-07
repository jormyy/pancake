import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import type { ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

/**
 * Frame for a screen opened on top of a tab (bracket, league settings, create
 * or join a league): a back button, the screen's title, and its main action on
 * the right.
 */
export function ModalScreen({
    title,
    onBack,
    backLabel = 'Back',
    actions,
    children,
}: {
    title: string
    onBack: () => void
    backLabel?: string
    actions?: ReactNode
    children: ReactNode
}) {
    const header = (
        <View style={styles.header}>
            <Pressable
                onPress={onBack}
                style={styles.back}
                role="link"
                aria-label={backLabel}
                accessibilityRole="link"
                accessibilityLabel={backLabel}
            >
                <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
            </Pressable>
            <Text style={styles.title} numberOfLines={1} role="heading" aria-level={1} accessibilityRole="header">
                {title}
            </Text>
            {actions}
        </View>
    )
    // The web shell already pads for the home indicator; only native needs the
    // bottom inset here.
    if (Platform.OS === 'web') {
        return <View style={styles.container}>{header}{children}</View>
    }
    return (
        <SafeAreaView style={styles.container} edges={['bottom']}>
            {header}
            {children}
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    header: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    back: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous',
        backgroundColor: colors.bgMuted,
    },
    title: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: fontSize.lg,
        fontWeight: fontWeight.bold,
    },
})
