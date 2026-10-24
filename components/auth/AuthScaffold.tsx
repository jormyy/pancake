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
import { authWebAttributes } from '@/components/auth/authScaffoldCss'
import { AuthHero, type AuthHeroContent } from '@/components/auth/AuthHero'
import { breakpoints, colors, layout, radii, shadows, spacing, textStyles, webBackgrounds, type WebOnlyViewStyle } from '@/constants/tokens'

type AuthScaffoldProps = {
    title: string
    hero: AuthHeroContent
    children: ReactNode
    footer: ReactNode
}

export function AuthScaffold({
    title,
    hero,
    children,
    footer,
}: AuthScaffoldProps) {
    const { width } = useWindowDimensions()
    const web = Platform.OS === 'web'
    const compact = !web && width < breakpoints.phone

    return (
        <KeyboardAvoidingView
            style={[styles.container, Platform.OS === 'web' && styles.containerWeb]}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={styles.shell} {...authWebAttributes('authShell')}>
                {web ? <AuthHero content={hero} /> : null}

                <View style={styles.formPanel}>
                    <ScrollView
                        contentContainerStyle={[styles.formScroll, compact && styles.formScrollCompact]}
                        {...authWebAttributes('authScroll')}
                        keyboardShouldPersistTaps="handled"
                    >
                        <View style={[styles.formCard, compact && styles.formCardCompact, web && styles.formCardWeb]} {...authWebAttributes('authCard')}>
                            <View style={styles.heading}>
                                <MobileBrand />
                                <Text style={styles.title} role="heading" aria-level={1}>{title}</Text>
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
        <View style={styles.mobileBrand} {...authWebAttributes('authMobileBrand')}>
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
    formCard: {
        width: '100%',
        maxWidth: layout.auth.maxWidth,
        padding: spacing['4xl'],
        borderRadius: radii['2xl'],
        borderWidth: 1,
        borderColor: colors.borderLight,
        backgroundColor: colors.bgCard,
    },
    formCardCompact: {
        padding: spacing.xl,
    },
    formCardWeb: {
        boxShadow: shadows.lg,
    } as WebOnlyViewStyle,
    mobileBrand: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
    },
    heading: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginBottom: spacing.xl },
    title: { ...textStyles.pageTitle, flex: 1 },
    footer: {
        marginTop: spacing.md,
        alignItems: 'center',
    },
})
