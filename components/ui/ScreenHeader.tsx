import { ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { useRouter } from 'expo-router'
import { colors, fontFamily, fontSize, fontWeight, motion, radii, spacing } from '@/constants/tokens'

type Props = {
    title: string
    subtitle?: string
    onBack?: () => void
    /** 'back' (chevron) or 'close' (x). Defaults to 'back'. */
    backVariant?: 'back' | 'close'
    right?: ReactNode
}

type PressableState = { hovered?: boolean; pressed?: boolean }

/**
 * Title + back/close header used by full-screen "page" surfaces (former modals)
 * now that the navigation header is hidden and the web shell persists around them.
 */
export function ScreenHeader({ title, subtitle, onBack, backVariant = 'back', right }: Props) {
    const router = useRouter()
    const handleBack = onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))

    return (
        <View style={styles.header}>
            <Pressable
                onPress={handleBack}
                accessibilityRole="button"
                accessibilityLabel={backVariant === 'close' ? 'Close' : 'Go back'}
                hitSlop={8}
                style={({ hovered, pressed }: PressableState) => [
                    styles.backBtn,
                    hovered && styles.backBtnHover,
                    pressed && styles.pressed,
                ]}
            >
                <MaterialIcons name={backVariant === 'close' ? 'close' : 'arrow-back'} size={22} color={colors.textPrimary} />
            </Pressable>
            <View style={styles.titleWrap}>
                <Text style={styles.title} numberOfLines={1}>
                    {title}
                </Text>
                {subtitle ? (
                    <Text style={styles.subtitle} numberOfLines={1}>
                        {subtitle}
                    </Text>
                ) : null}
            </View>
            {right ? <View style={styles.right}>{right}</View> : <View style={styles.backBtn} />}
        </View>
    )
}

const styles = StyleSheet.create({
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        minHeight: 60,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        backgroundColor: colors.bgCard,
        ...Platform.select({ web: { position: 'sticky' as 'relative', top: 0, zIndex: 10 }, default: {} }),
    },
    backBtn: {
        width: 40,
        height: 40,
        borderRadius: radii.md,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.bgMuted,
    },
    backBtnHover: { backgroundColor: colors.bgSubtle },
    pressed: { opacity: motion.pressedOpacity },
    titleWrap: { flex: 1, minWidth: 0 },
    title: {
        fontSize: fontSize.xl,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        letterSpacing: -0.3,
    },
    subtitle: {
        fontSize: fontSize.sm,
        color: colors.textMuted,
        marginTop: 1,
    },
    right: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
})
