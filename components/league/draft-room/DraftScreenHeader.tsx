import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { colors, fontFamily, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

export function DraftScreenHeader({
    title,
    onBack,
    children,
}: {
    title: string
    onBack: () => void
    children?: ReactNode
}) {
    return (
        <View style={styles.screenHeader}>
            <Pressable
                onPress={onBack}
                style={styles.headerBack}
                role="link"
                aria-label="Back to league drafts"
                accessibilityRole="link"
                accessibilityLabel="Back to league drafts"
            >
                <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
            </Pressable>
            <Text style={styles.screenTitle} numberOfLines={1}>
                {title}
            </Text>
            {children}
        </View>
    )
}

const styles = StyleSheet.create({
    screenHeader: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    headerBack: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    screenTitle: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: fontSize.lg,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
    },
})
