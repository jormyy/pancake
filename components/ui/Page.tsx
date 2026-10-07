import { ReactNode } from 'react'
import { Platform, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { breakpoints, colors, layout, spacing, srOnly, textStyles } from '@/constants/tokens'

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
 * One row at the top of a page: section tabs or a title on the left, the
 * page's main action on the right.
 */
export function PageHeader({
    title,
    tabs,
    actions,
}: {
    title?: string
    tabs?: ReactNode
    actions?: ReactNode
}) {
    const { padX } = usePageMetrics()
    return (
        <View style={[styles.header, { paddingHorizontal: padX }]}>
            <View style={styles.headerMain}>
                {tabs ?? (title ? <Text style={textStyles.pageTitle} numberOfLines={1}>{title}</Text> : null)}
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
        minHeight: 48,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    headerMain: { flex: 1, minWidth: 0 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexShrink: 0, alignSelf: 'center' },
})
