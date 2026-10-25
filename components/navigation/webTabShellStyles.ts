import { StyleSheet } from 'react-native'
import { brand, colors, controlSize, fontFamily, fontSize, fontWeight, layout, motion, radii, shadows, spacing, textStyles, webBackgrounds, webOverlays, type WebOnlyViewStyle } from '@/constants/tokens'

const MOBILE_TOPBAR_HEIGHT = controlSize.minTouch
const MOBILE_BOTTOMBAR_HEIGHT = layout.shell.bottomBarHeight

export const styles = StyleSheet.create({
    root: {
        flex: 1,
        minHeight: '100%',
        backgroundColor: colors.bgScreen,
        backgroundImage: webBackgrounds.appRoot,
    } as WebOnlyViewStyle,
    rootDesktop: {
        flexDirection: 'row',
    },
    rootCompact: {
        flexDirection: 'column',
    },
    flex1: { flex: 1, minWidth: 0 },
    pressed: {
        opacity: motion.pressedOpacity,
    },

    sidebar: {
        width: layout.sidebarWidth,
        flexShrink: 0,
        // Pin to the viewport height so the nav ScrollView scrolls on short
        // screens (landscape phones) instead of clipping the lower items when
        // the content column stretches the row taller than the viewport.
        height: '100vh',
        maxHeight: '100vh',
        backgroundColor: brand.surface,
        backgroundImage: webBackgrounds.sidebar,
        paddingBottom: spacing.lg,
        borderRightWidth: 1,
        borderRightColor: brand.divider,
    } as unknown as WebOnlyViewStyle,
    sidebarScroll: {
        flex: 1,
    },
    sidebarScrollContent: {
        paddingHorizontal: spacing.xl,
        paddingTop: spacing['2xl'],
        gap: spacing.md,
    },
    brandRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingHorizontal: spacing.md,
        paddingTop: spacing.sm,
        paddingBottom: spacing.xl,
    },
    brandMark: {
        width: controlSize.minTouch,
        height: controlSize.minTouch,
    },
    brandMarkCompact: {
        width: controlSize.minTouch,
        height: controlSize.minTouch,
    },
    brandTitle: {
        fontSize: fontSize.xl,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.extrabold,
        color: brand.on,
        letterSpacing: 0,
    },

    leagueSwitchWrap: {
        position: 'relative',
        zIndex: 20,
        marginBottom: spacing.md,
    },
    leagueSwitch: {
        height: layout.shell.leagueHeight,
        flexShrink: 0,
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        borderRadius: radii.lg,
        backgroundColor: brand.overlay,
        borderWidth: 1,
        borderColor: brand.borderSubtle,
    },
    leagueSwitchHover: {
        backgroundColor: brand.overlayHover,
    },
    leagueName: {
        color: brand.onStrong,
        fontWeight: fontWeight.bold,
        fontSize: fontSize.md,
        fontFamily: fontFamily.displayMedium,
        lineHeight: textStyles.rowTitle.lineHeight,
    },
    leagueMeta: {
        color: brand.onSubtle,
        fontSize: fontSize.xs,
        lineHeight: textStyles.sectionLabel.lineHeight,
    },
    commissionerSlot: { height: controlSize.minTouch },
    // Light variant for the mobile top bar (web is light-themed). Kept at the
    // touch-target floor while staying visually aligned with the compact brand mark.
    leagueSwitchWrapLight: {
        // The sidebar spacing below the switcher misaligns the fixed-height
        // mobile top bar; the topbar centers a strict 44px control instead.
        marginBottom: 0,
    },
    leagueSwitchLight: {
        height: controlSize.minTouch,
        minHeight: controlSize.minTouch,
        paddingVertical: spacing.xs,
        paddingHorizontal: spacing.md,
        gap: spacing.md,
        backgroundColor: colors.bgMuted,
        borderColor: colors.borderLight,
    },
    leagueSwitchLightHover: {
        backgroundColor: colors.bgSubtle,
    },
    leagueNameLight: {
        color: colors.textPrimary,
        fontWeight: fontWeight.bold,
        fontSize: fontSize.lg,
        lineHeight: textStyles.body.lineHeight,
    },
    leagueMetaLight: {
        color: colors.textMuted,
        fontSize: fontSize.xs,
    },
    // Full-screen layer for the open league menu; its backdrop catches outside taps.
    leagueMenuLayer: {
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 1000,
    } as unknown as WebOnlyViewStyle,
    // Positioned by the switcher from its measured place on screen.
    leagueMenu: {
        position: 'absolute',
        zIndex: 100,
        borderRadius: radii.xl,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgCard,
        boxShadow: shadows.lg,
    } as WebOnlyViewStyle,
    leagueMenuItem: {
        minHeight: controlSize.minTouch,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        padding: spacing.md,
        borderRadius: radii.md,
    },
    leagueMenuItemActive: {
        backgroundColor: colors.bgMuted,
    },
    leagueMenuItemHover: {
        backgroundColor: colors.bgSubtle,
    },
    leagueMenuName: {
        color: colors.textPrimary,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
    },
    leagueMenuMeta: {
        color: colors.textMuted,
        fontSize: fontSize.xs,
    },

    navGroup: {
        gap: spacing.xs,
    },
    navDivider: {
        height: 1,
        marginVertical: spacing.sm,
        marginHorizontal: spacing.lg,
        backgroundColor: brand.borderSubtle,
    },
    sideNavItem: {
        display: 'flex',
        width: '100%',
        height: controlSize.minTouch,
        minHeight: controlSize.minTouch,
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.lg,
        textDecorationLine: 'none',
    } as WebOnlyViewStyle,
    navIconFrame: {
        width: controlSize.icon.md,
        height: controlSize.icon.md,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    sideNavItemHover: {
        backgroundColor: brand.overlay,
    },
    // No glow: matches the boot shell's active item, so nothing shifts on mount.
    sideNavItemActive: {
        backgroundColor: colors.primary,
    },
    sideNavItemDisabled: {
        opacity: motion.pressedOpacity,
    },
    sideNavText: {
        flex: 1,
        color: brand.onStrong,
        fontSize: fontSize.md,
        fontWeight: fontWeight.semibold,
    },
    sideNavTextActive: {
        color: brand.on,
    },
    // Pending-count pill on nav items — same dimensions as the
    // SegmentedControl badge so counts read consistently across the app.
    navBadge: {
        minWidth: controlSize.button.md.icon,
        height: controlSize.button.md.icon,
        paddingHorizontal: spacing.xs,
        borderRadius: radii.full,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.primary,
    },
    navBadgeActive: {
        backgroundColor: webOverlays.navBadgeActive,
    },
    navBadgeText: {
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.bold,
        color: colors.textWhite,
    },
    bottomNavIconWrap: {
        position: 'relative',
    },
    bottomNavBadge: {
        position: 'absolute',
        top: -spacing.xs,
        right: -spacing.lg,
        borderWidth: 1.5,
        borderColor: colors.bgCard,
    },

    sidebarFooter: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.md,
        borderTopWidth: 1,
        borderTopColor: brand.borderSubtle,
    },
    userChip: {
        minHeight: controlSize.button.lg.height,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
    },
    userChipHover: {
        backgroundColor: brand.overlay,
    },
    // Same fill as the active nav item, so the current page reads the same way.
    userChipActive: {
        backgroundColor: colors.primary,
    },
    userTextActive: {
        color: brand.on,
    },
    userName: {
        color: brand.onStrong,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
    },
    userMeta: {
        color: brand.onSubtle,
        fontSize: fontSize.xs,
    },

    content: {
        flex: 1,
        minWidth: 0,
        backgroundColor: colors.bgScreen,
        backgroundImage: webBackgrounds.appContent,
    } as WebOnlyViewStyle,
    // The document opts into viewport-fit=cover, so the fixed bars must pad by
    // the safe-area insets or standalone-PWA launches put the top bar under the
    // notch and the bottom tabs under the home indicator.
    contentCompact: {
        paddingTop: `calc(${MOBILE_TOPBAR_HEIGHT}px + env(safe-area-inset-top, 0px))`,
        paddingBottom: `calc(${MOBILE_BOTTOMBAR_HEIGHT}px + env(safe-area-inset-bottom, 0px))`,
    } as unknown as WebOnlyViewStyle,

    contentWithBackHeader: {
        paddingTop: 'env(safe-area-inset-top, 0px)',
    } as unknown as WebOnlyViewStyle,

    mobileTopbar: {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        height: `calc(${MOBILE_TOPBAR_HEIGHT}px + env(safe-area-inset-top, 0px))`,
        paddingTop: 'env(safe-area-inset-top, 0px)',
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
        backgroundColor: webOverlays.mobileTopbar,
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        boxShadow: shadows.sm,
    } as unknown as WebOnlyViewStyle,
    mobileLeagueWrap: {
        flex: 1,
        minWidth: 0,
    },
    mobileMenuButton: {
        width: controlSize.minTouch,
        height: controlSize.minTouch,
        borderRadius: radii.lg,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.bgMuted,
    },
    mobileBottomNav: {
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 50,
        height: `calc(${MOBILE_BOTTOMBAR_HEIGHT}px + env(safe-area-inset-bottom, 0px))`,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-around',
        paddingBottom: `calc(${spacing.xs}px + env(safe-area-inset-bottom, 0px))`,
        backgroundColor: webOverlays.mobileBottomNav,
        borderTopWidth: 1,
        borderTopColor: colors.borderLight,
        boxShadow: shadows.topNav,
    } as unknown as WebOnlyViewStyle,
    bottomNavItem: {
        display: 'flex',
        flex: 1,
        minHeight: controlSize.minTouch,
        height: layout.shell.tabHeight,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.xs,
        textDecorationLine: 'none',
    } as WebOnlyViewStyle,
    bottomNavText: {
        width: '100%',
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        textAlign: 'center',
    },
    bottomNavTextActive: {
        color: colors.primaryDark,
    },

    sheetItem: {
        minHeight: controlSize.minTouch,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        borderRadius: radii.md,
        paddingHorizontal: spacing.sm,
    },
    sheetItemActive: {
        backgroundColor: colors.bgMuted,
    },
    sheetItemTextActive: {
        color: colors.primaryDark,
    },
    sheetItemText: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: fontSize.md,
        fontWeight: fontWeight.bold,
    },
})
