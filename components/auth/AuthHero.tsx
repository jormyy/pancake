import { Platform, StyleSheet, Text, View } from 'react-native'
import { AuthBrandMark } from '@/components/auth/AuthBrandMark'
import { authWebAttributes } from '@/components/auth/authScaffoldCss'
import { MotionView } from '@/components/Motion'
import { brand, fontFamily, fontWeight, radii, spacing, webBackgrounds, type WebOnlyViewStyle, typeScale } from '@/constants/tokens'

export type AuthHeroContent = {
    title: string
    copy: string
    proofItems: readonly string[]
}

export function AuthHero({ content }: { content: AuthHeroContent }) {
    return (
        <View style={[styles.panel, Platform.OS === 'web' && styles.panelWeb]} {...authWebAttributes('authHero')}>
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
        padding: spacing['6xl'],
        justifyContent: 'center',
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
    content: {
        marginTop: spacing['4xl'],
        maxWidth: 640,
    },
    title: {
        ...typeScale.hero,
        color: brand.on,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.black,
    },
    copy: {
        ...typeScale.title,
        marginTop: spacing.lg,
        color: brand.onMuted,
        maxWidth: 560,
    },
    proofGrid: {
        marginTop: spacing['4xl'],
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.md,
        maxWidth: 640,
    },
    proofCard: {
        width: '48%',
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: brand.borderSubtle,
        backgroundColor: brand.overlay,
    },
    proofText: {
        ...typeScale.row,
        color: brand.onStrong,
        fontWeight: fontWeight.semibold,
    },
})
