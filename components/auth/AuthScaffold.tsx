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
import { brand, breakpoints, colors, elevation, fontFamily, fontSize, fontWeight, radii, shadows, spacing } from '@/constants/tokens'
import { MotionView } from '@/components/Motion'

type AuthScaffoldProps = {
    eyebrow: string
    title: string
    subtitle: string
    heroTitle: string
    heroCopy: string
    proofItems: readonly string[]
    children: ReactNode
    footer: ReactNode
}

type WebAuthStyle = {
    backgroundImage?: string
    boxShadow?: string
}

export function AuthScaffold({
    eyebrow,
    title,
    subtitle,
    heroTitle,
    heroCopy,
    proofItems,
    children,
    footer,
}: AuthScaffoldProps) {
    const { width } = useWindowDimensions()
    const split = Platform.OS === 'web' && width >= breakpoints.auth

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={[styles.shell, split && styles.shellSplit]}>
                {split ? (
                    <View style={styles.heroPanel}>
                        <View style={styles.brandTop}>
                            <BrandMark />
                            <View>
                                <Text style={styles.brandName}>Pancake</Text>
                                <Text style={styles.brandSub}>Manager console</Text>
                            </View>
                        </View>

                        <View style={styles.heroContent}>
                            <Text style={styles.heroKicker}>Dynasty basketball operations</Text>
                            <Text style={styles.heroTitle}>{heroTitle}</Text>
                            <Text style={styles.heroCopy}>{heroCopy}</Text>
                        </View>

                        <View style={styles.proofGrid}>
                            {proofItems.map((item, index) => (
                                <MotionView
                                    key={item}
                                    delay={120 + index * 70}
                                    preset={index % 2 === 0 ? 'rise' : 'slide-left'}
                                    style={styles.proofCard}
                                >
                                    <Text style={styles.proofText}>{item}</Text>
                                </MotionView>
                            ))}
                        </View>

                        <View style={styles.previewPanel}>
                            <View style={styles.previewHeader}>
                                <Text style={styles.previewTitle}>Tonight</Text>
                                <Text style={styles.previewPill}>Live board</Text>
                            </View>
                            <PreviewRow label="Lineup edge" value="+42.6" />
                            <PreviewRow label="Waiver budget" value="$61" />
                            <PreviewRow label="Pick bank" value="15 assets" />
                        </View>
                    </View>
                ) : null}

                <View style={styles.formPanel}>
                    <ScrollView
                        contentContainerStyle={[styles.formScroll, split && styles.formScrollSplit]}
                        keyboardShouldPersistTaps="handled"
                    >
                        <View style={styles.formCard}>
                            {!split ? (
                                <View style={styles.mobileBrand}>
                                    <BrandMark compact />
                                    <View>
                                        <Text style={styles.mobileBrandName}>Pancake</Text>
                                        <Text style={styles.mobileBrandSub}>Manager console</Text>
                                    </View>
                                </View>
                            ) : null}

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

function BrandMark({ compact = false }: { compact?: boolean }) {
    return (
        <View style={[styles.brandMark, compact && styles.brandMarkCompact]}>
            <Text style={[styles.brandMarkText, compact && styles.brandMarkTextCompact]}>P</Text>
        </View>
    )
}

function PreviewRow({ label, value }: { label: string; value: string }) {
    return (
        <View style={styles.previewRow}>
            <Text style={styles.previewLabel}>{label}</Text>
            <Text style={styles.previewValue}>{value}</Text>
        </View>
    )
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.bgScreen,
        backgroundImage: 'radial-gradient(circle at 84% 8%, rgba(47, 122, 91, 0.12), transparent 32%), linear-gradient(135deg, #FFFDF7 0%, #F7F1E8 54%, #EDE0CE 100%)',
    } as WebAuthStyle,
    shell: { flex: 1 },
    shellSplit: { flexDirection: 'row' },

    heroPanel: {
        flex: 1.16,
        minWidth: 0,
        padding: 56,
        backgroundColor: brand.surfaceDeep,
        backgroundImage: `radial-gradient(circle at 24% 12%, rgba(166, 83, 23, 0.30), transparent 30%), radial-gradient(circle at 80% 30%, rgba(47, 122, 91, 0.22), transparent 34%), linear-gradient(155deg, ${brand.surface} 0%, ${brand.surfaceDeeper} 100%)`,
    } as WebAuthStyle,
    brandTop: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
    },
    brandMark: {
        width: 48,
        height: 48,
        borderRadius: radii.xl,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.primary,
        ...(elevation('brandGlowInset') as object),
    },
    brandMarkCompact: {
        width: 42,
        height: 42,
        borderRadius: radii.lg,
    },
    brandMarkText: {
        color: brand.on,
        fontSize: fontSize['2xl'],
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
    },
    brandMarkTextCompact: { fontSize: 22 },
    brandName: {
        color: brand.on,
        fontSize: 23,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
    },
    brandSub: {
        marginTop: -2,
        color: brand.onSubtle,
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.bold,
        letterSpacing: 1.5,
        textTransform: 'uppercase' as const,
    },
    heroContent: {
        marginTop: 72,
        maxWidth: 760,
    },
    heroKicker: {
        color: brand.onSubtle,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
    },
    heroTitle: {
        marginTop: spacing.lg,
        color: brand.on,
        fontSize: 50,
        lineHeight: 55,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.black,
    },
    heroCopy: {
        marginTop: spacing.xl,
        color: brand.onMuted,
        fontSize: fontSize.lg,
        lineHeight: 27,
        maxWidth: 620,
    },
    proofGrid: {
        marginTop: 40,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.lg,
        maxWidth: 760,
    },
    proofCard: {
        width: '48%',
        minHeight: 82,
        padding: spacing.lg,
        borderRadius: radii.xl,
        borderWidth: 1,
        borderColor: brand.borderSubtle,
        backgroundColor: brand.overlay,
    },
    proofText: {
        color: brand.onStrong,
        fontSize: fontSize.md,
        lineHeight: 20,
        fontWeight: fontWeight.semibold,
    },
    previewPanel: {
        marginTop: spacing.xl,
        maxWidth: 420,
        padding: spacing.xl,
        borderRadius: radii['2xl'],
        borderWidth: 1,
        borderColor: brand.border,
        backgroundColor: 'rgba(255, 248, 234, 0.08)',
    },
    previewHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: spacing.lg,
    },
    previewTitle: {
        color: brand.on,
        fontSize: fontSize.lg,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
    },
    previewPill: {
        color: colors.textWhite,
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        backgroundColor: colors.primary,
        borderRadius: radii.full,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        overflow: 'hidden',
    },
    previewRow: {
        minHeight: 36,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderTopWidth: 1,
        borderTopColor: brand.borderSubtle,
    },
    previewLabel: {
        color: brand.onMuted,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
    },
    previewValue: {
        color: brand.on,
        fontSize: fontSize.md,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.bold,
    },

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
        boxShadow: shadows.lg,
    } as WebAuthStyle,
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
