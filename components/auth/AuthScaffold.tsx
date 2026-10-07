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
import { breakpoints, colors, fontFamily, fontSize, fontWeight, radii, shadows, spacing, textStyles, webBackgrounds, type WebOnlyViewStyle } from '@/constants/tokens'

type AuthScaffoldProps = {
    eyebrow: string
    title: string
    subtitle?: string
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
    const compact = width < breakpoints.phone

    return (
        <KeyboardAvoidingView
            style={[styles.container, Platform.OS === 'web' && styles.containerWeb]}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={[styles.shell, split && styles.shellSplit]}>
                {split ? <AuthHero content={hero} /> : null}

                <View style={styles.formPanel}>
                    <ScrollView
                        contentContainerStyle={[styles.formScroll, compact && styles.formScrollCompact, split && styles.formScrollSplit]}
                        keyboardShouldPersistTaps="handled"
                    >
                        <View style={[styles.formCard, compact && styles.formCardCompact, Platform.OS === 'web' && styles.formCardWeb]}>
                            {!split ? <MobileBrand /> : null}

                            <View style={styles.titleBlock}>
                                <Text style={styles.eyebrow}>{eyebrow}</Text>
                                <Text style={[styles.title, compact && styles.titleCompact]} role="heading" aria-level={1}>{title}</Text>
                                {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
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
    // Stretch so the scroll area spans the panel; the scroll content centers the card.
    formPanel: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'stretch',
    },
    formScroll: {
        flexGrow: 1,
        width: '100%',
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: spacing['3xl'],
        paddingVertical: spacing['4xl'],
    },
    // Phones: the card fills the width so the form starts above the fold.
    formScrollCompact: {
        justifyContent: 'flex-start',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.xl,
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
    formCardCompact: {
        padding: spacing['2xl'],
    },
    formCardWeb: {
        boxShadow: shadows.lg,
    } as WebOnlyViewStyle,
    mobileBrand: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        marginBottom: spacing.xl,
    },
    titleBlock: { marginBottom: spacing['2xl'] },
    eyebrow: {
        ...textStyles.sectionLabel,
        color: colors.primaryDark,
        marginBottom: spacing.sm,
    },
    title: {
        color: colors.textPrimary,
        fontSize: fontSize['4xl'],
        lineHeight: 38,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.black,
    },
    titleCompact: {
        fontSize: fontSize['3xl'],
        lineHeight: 32,
    },
    subtitle: {
        ...textStyles.body,
        color: colors.textMuted,
        marginTop: spacing.md,
    },
    footer: {
        marginTop: spacing.xl,
        alignItems: 'center',
    },
})
