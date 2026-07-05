import { ReactNode } from 'react'
import {
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    StyleSheet,
    Text,
    View,
    useWindowDimensions,
} from 'react-native'
import { AuthBrandMark } from '@/components/auth/AuthBrandMark'
import { AuthHero, type AuthHeroContent } from '@/components/auth/AuthHero'
import { breakpoints, colors, fontFamily, fontSize, fontWeight, radii, shadows, spacing, webBackgrounds, type WebOnlyViewStyle } from '@/constants/tokens'

type AuthScaffoldProps = {
    eyebrow: string
    title: string
    subtitle: string
    hero: AuthHeroContent
    children: ReactNode
    footer: ReactNode
}

export function AuthScaffold({
    eyebrow,
    title,
    subtitle,
    hero,
    children,
    footer,
}: AuthScaffoldProps) {
    const { width } = useWindowDimensions()
    const split = Platform.OS === 'web' && width >= breakpoints.auth

    return (
        <KeyboardAvoidingView
            style={[styles.container, Platform.OS === 'web' && styles.containerWeb]}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={[styles.shell, split && styles.shellSplit]}>
                {split ? <AuthHero content={hero} /> : null}

                <View style={styles.formPanel}>
                    <ScrollView
                        contentContainerStyle={[styles.formScroll, split && styles.formScrollSplit]}
                        keyboardShouldPersistTaps="handled"
                    >
                        <View style={[styles.formCard, Platform.OS === 'web' && styles.formCardWeb]}>
                            {!split ? <MobileBrand /> : null}

                            <View style={styles.titleBlock}>
                                <Text style={styles.eyebrow}>{eyebrow}</Text>
                                <Text style={styles.title}>{title}</Text>
                                <Text style={styles.subtitle}>{subtitle}</Text>
                            </View>

                            {children}

                            <View style={styles.footer}>{footer}</View>
                        </View>
                    </ScrollView>
                </View>
            </View>
        </KeyboardAvoidingView>
    )
}

function MobileBrand() {
    return (
        <View style={styles.mobileBrand}>
            <AuthBrandMark compact />
            <View>
                <Text style={styles.mobileBrandName}>Pancake</Text>
                <Text style={styles.mobileBrandSub}>Manager console</Text>
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bgScreen,
    },
    containerWeb: {
        backgroundImage: webBackgrounds.authScreen,
    } as WebOnlyViewStyle,
    shell: { flex: 1 },
    shellSplit: { flexDirection: 'row' },
    formPanel: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    formScroll: {
        flexGrow: 1,
        width: '100%',
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 28,
        paddingVertical: 46,
    },
    formScrollSplit: {
        paddingHorizontal: spacing['5xl'],
        paddingVertical: spacing['5xl'],
    },
    formCard: {
        width: '100%',
        maxWidth: 448,
        padding: spacing['4xl'],
        borderRadius: radii['2xl'],
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    formCardWeb: {
        boxShadow: shadows.lg,
    } as WebOnlyViewStyle,
    mobileBrand: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        marginBottom: spacing['4xl'],
    },
    mobileBrandName: {
        color: colors.textPrimary,
        fontSize: 22,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
    },
    mobileBrandSub: {
        color: colors.textMuted,
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.bold,
        letterSpacing: 1.4,
        textTransform: 'uppercase' as const,
    },
    titleBlock: { marginBottom: spacing['3xl'] },
    eyebrow: {
        color: colors.primaryDark,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.extrabold,
        letterSpacing: 1.1,
        textTransform: 'uppercase' as const,
        marginBottom: spacing.sm,
    },
    title: {
        color: colors.textPrimary,
        fontSize: 34,
        lineHeight: 38,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.black,
    },
    subtitle: {
        color: colors.textMuted,
        fontSize: fontSize.md,
        lineHeight: 21,
        marginTop: spacing.md,
    },
    footer: {
        marginTop: spacing['3xl'],
        alignItems: 'center',
    },
})
