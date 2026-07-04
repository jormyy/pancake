import { Platform, StyleSheet, Text, View } from 'react-native'
import { AuthBrandMark } from '@/components/auth/AuthBrandMark'
import { MotionView } from '@/components/Motion'
import { brand, colors, fontFamily, fontSize, fontWeight, radii, spacing, webBackgrounds, webOverlays, type WebOnlyViewStyle } from '@/constants/tokens'

export type AuthPreviewMetric = {
    label: string
    value: string
}

export type AuthHeroContent = {
    kicker: string
    title: string
    copy: string
    proofItems: readonly string[]
    previewTitle: string
    previewBadge: string
    previewRows: readonly AuthPreviewMetric[]
}

export function AuthHero({ content }: { content: AuthHeroContent }) {
    return (
        <View style={[styles.panel, Platform.OS === 'web' && styles.panelWeb]}>
            <View style={styles.brandTop}>
                <AuthBrandMark />
                <View>
                    <Text style={styles.brandName}>Pancake</Text>
                    <Text style={styles.brandSub}>Manager console</Text>
                </View>
            </View>

            <View style={styles.content}>
                <Text style={styles.kicker}>{content.kicker}</Text>
                <Text style={styles.title}>{content.title}</Text>
                <Text style={styles.copy}>{content.copy}</Text>
            </View>

            <View style={styles.proofGrid}>
                {content.proofItems.map((item, index) => (
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

            <AuthPreview title={content.previewTitle} badge={content.previewBadge} rows={content.previewRows} />
        </View>
    )
}

function AuthPreview({
    title,
    badge,
    rows,
}: {
    title: string
    badge: string
    rows: readonly AuthPreviewMetric[]
}) {
    return (
        <View style={styles.previewPanel}>
            <View style={styles.previewHeader}>
                <Text style={styles.previewTitle}>{title}</Text>
                <Text style={styles.previewPill}>{badge}</Text>
            </View>
            {rows.map((row) => (
                <View key={row.label} style={styles.previewRow}>
                    <Text style={styles.previewLabel}>{row.label}</Text>
                    <Text style={styles.previewValue}>{row.value}</Text>
                </View>
            ))}
        </View>
    )
}

const styles = StyleSheet.create({
    panel: {
        flex: 1.16,
        minWidth: 0,
        padding: 56,
        backgroundColor: brand.surfaceDeep,
    },
    panelWeb: {
        backgroundImage: webBackgrounds.authHero,
    } as WebOnlyViewStyle,
    brandTop: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
    },
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
    content: {
        marginTop: 72,
        maxWidth: 760,
    },
    kicker: {
        color: brand.onSubtle,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
    },
    title: {
        marginTop: spacing.lg,
        color: brand.on,
        fontSize: 50,
        lineHeight: 55,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.black,
    },
    copy: {
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
        backgroundColor: webOverlays.brandPreview,
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
})
