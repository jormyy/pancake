import { Platform, StyleSheet, Text, View } from 'react-native'
import { AuthBrandMark } from '@/components/auth/AuthBrandMark'
import { MotionView } from '@/components/Motion'
import { brand, fontFamily, fontSize, fontWeight, radii, spacing, webBackgrounds, type WebOnlyViewStyle } from '@/constants/tokens'

export type AuthHeroContent = {
    kicker: string
    title: string
    copy: string
    proofItems: readonly string[]
    previewTitle: string
    previewBadge: string
    previewRows: readonly { label: string; value: string }[]
}

export function AuthHero({ content }: { content: AuthHeroContent }) {
    return (
        <View style={[styles.panel, Platform.OS === 'web' && styles.panelWeb]}>
            <View style={styles.brandTop}>
                <AuthBrandMark />
            </View>

            <View style={styles.content}>
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
        marginTop: 32,
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
})
