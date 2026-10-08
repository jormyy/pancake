import { ReactNode } from 'react'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { breakpoints, colors, layout, radii, spacing, srOnly, textStyles } from '@/constants/tokens'

type PageWidth = 'content' | 'form' | 'full'

const MAX_WIDTH: Record<PageWidth, number | undefined> = {
    content: layout.contentMaxWidth,
    form: layout.formMaxWidth,
    full: undefined,
}

/** Shared page metrics so every screen pads and splits at the same widths. */
export function usePageMetrics() {
    const { width } = useWindowDimensions()
    const compact = width < breakpoints.compact
    const padX = compact ? layout.pagePadX.compact : layout.pagePadX.regular
    const shellInset = Platform.OS === 'web' && !compact ? layout.sidebarWidth : 0
    return {
        compact,
        padX,
        /** Width left for page content after the web sidebar and page padding. */
        usableWidth: width - shellInset - 2 * padX,
    }
}

/**
 * The frame every screen sits in: screen background, one centered column with
 * a width cap, and the page's h1. The h1 is screen-reader only because the
 * navigation already shows which page is open.
 */
export function Page({
    title,
    width = 'content',
    padded = false,
    children,
    style,
}: {
    title: string
    width?: PageWidth
    padded?: boolean
    children: ReactNode
    style?: StyleProp<ViewStyle>
}) {
    const { padX } = usePageMetrics()
    // The web shell already pads for the notch and home indicator. A
    // SafeAreaView here would add the same inset twice in the installed iPhone app.
    const Frame = Platform.OS === 'web' ? View : SafeAreaView
    return (
        <Frame style={styles.screen}>
            <Text style={srOnly} role="heading" aria-level={1} accessibilityRole="header">{title}</Text>
            <View style={[styles.column, { maxWidth: MAX_WIDTH[width] }, padded && { paddingHorizontal: padX }, style]}>
                {children}
            </View>
        </Frame>
    )
}

/**
 * The back control for screens opened on top of a tab. The installed iPhone
 * app has no back swipe, so every such screen shows one in the same place.
 */
export function BackButton({ onPress, label = 'Back' }: { onPress: () => void; label?: string }) {
    return (
        <Pressable
            onPress={onPress}
            style={({ pressed }: { pressed?: boolean }) => [styles.back, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={label}
        >
            <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
        </Pressable>
    )
}

/**
 * One row at the top of a page: an optional back control, then section tabs
 * or a title (with an optional meta line), then the page's main action.
 */
export function PageHeader({
    title,
    meta,
    tabs,
    actions,
    onBack,
    backLabel,
    titleIsPageHeading = false,
}: {
    title?: string
    meta?: string
    tabs?: ReactNode
    actions?: ReactNode
    onBack?: () => void
    backLabel?: string
    /** Make the visible title the page's h1 (screens not wrapped in Page). */
    titleIsPageHeading?: boolean
}) {
    const { padX } = usePageMetrics()
    const headingProps = titleIsPageHeading
        ? ({ role: 'heading', 'aria-level': 1, accessibilityRole: 'header' } as const)
        : {}
    return (
        <View style={[styles.header, !tabs && styles.headerCentered, { paddingHorizontal: padX }]}>
            {onBack ? <View style={styles.headerBack}><BackButton onPress={onBack} label={backLabel} /></View> : null}
            <View style={styles.headerMain}>
                {tabs ?? (title ? (
                    <>
                        <Text style={textStyles.pageTitle} numberOfLines={1} {...headingProps}>{title}</Text>
                        {meta ? <Text style={textStyles.meta} numberOfLines={1}>{meta}</Text> : null}
                    </>
                ) : null)}
            </View>
            {actions ? <View style={styles.headerActions}>{actions}</View> : null}
        </View>
    )
}

const styles = StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bgScreen },
    column: { flex: 1, minHeight: 0, width: '100%', alignSelf: 'center' },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: spacing.md,
        minHeight: 56,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    // Tabs sit on the bottom border; titles and back controls center in the row.
    headerCentered: { alignItems: 'center', minHeight: 56, paddingVertical: spacing.xs },
    headerBack: { alignSelf: 'center' },
    headerMain: { flex: 1, minWidth: 0 },
    back: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous',
        backgroundColor: colors.bgMuted,
    },
    pressed: { opacity: 0.76 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexShrink: 0, alignSelf: 'center' },
})
