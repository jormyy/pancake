import { StyleSheet } from 'react-native'
import { brand, colors, fontFamily, fontSize, fontWeight, radii, shadows, spacing, webBackgrounds, webOverlays, type WebOnlyViewStyle } from '@/constants/tokens'

const SIDEBAR_WIDTH = 264
const MOBILE_TOPBAR_HEIGHT = 56
const MOBILE_BOTTOMBAR_HEIGHT = 64

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
        opacity: 0.76,
    },

    sidebar: {
        width: SIDEBAR_WIDTH,
        flexShrink: 0,
        // Pin to the viewport height so the nav ScrollView scrolls on short
        // screens (landscape phones) instead of clipping the lower items when
        // the content column stretches the row taller than the viewport.
        height: '100vh',
        maxHeight: '100vh',
        backgroundColor: brand.surface,
        backgroundImage: webBackgrounds.sidebar,
        paddingBottom: 14,
        borderRightWidth: 1,
        borderRightColor: brand.divider,
    } as unknown as WebOnlyViewStyle,
    sidebarScroll: {
        flex: 1,
    },
    sidebarScrollContent: {
        paddingHorizontal: 16,
        paddingTop: 20,
        gap: spacing.md,
    },
    brandRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
        paddingHorizontal: 10,
        paddingTop: 6,
        paddingBottom: 16,
    },
    brandMark: {
        width: 42,
        height: 42,
    },
    brandMarkCompact: {
        width: 34,
        height: 34,
    },
    brandTitle: {
        fontSize: 21,
        fontFamily: fontFamily.display,
        fontWeight: fontWeight.extrabold,
        color: brand.on,
        letterSpacing: 0,
    },
    brandSubtitle: {
        marginTop: -2,
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.bold,
        letterSpacing: 1.1,
        textTransform: 'uppercase',
        color: brand.onSubtle,
    },

    leagueSwitchWrap: {
        position: 'relative',
        zIndex: 20,
        marginBottom: spacing.md,
    },
    leagueSwitch: {
        minHeight: 58,
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
    leagueCrest: {
        width: 34,
        height: 34,
        borderRadius: radii.lg,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    leagueCrestText: {
        color: colors.textWhite,
        fontWeight: fontWeight.extrabold,
        fontSize: fontSize.sm,
    },
    leagueName: {
        color: brand.onStrong,
        fontWeight: fontWeight.bold,
        fontSize: fontSize.md,
        fontFamily: fontFamily.displayMedium,
    },
    leagueMeta: {
        color: brand.onSubtle,
        fontSize: fontSize.xs,
    },
    // Light variant for the mobile top bar (web is light-themed). Kept at the
    // touch-target floor while staying visually aligned with the compact brand mark.
    leagueSwitchLight: {
        minHeight: 44,
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
        fontSize: fontSize.sm,
    },
    leagueMetaLight: {
        color: colors.textMuted,
        fontSize: fontSize.xs,
    },
    leagueMenu: {
        position: 'absolute',
        // Anchor to the bottom of the switch (whatever its height) so the menu
        // sits flush below both the 52px sidebar switch and the 40px mobile one.
        top: '100%',
        marginTop: spacing.xs,
        left: 0,
        right: 0,
        zIndex: 100,
        padding: spacing.sm,
        borderRadius: radii.xl,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgCard,
        boxShadow: shadows.lg,
    } as WebOnlyViewStyle,
    leagueMenuItem: {
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
    leagueMenuCrest: {
        width: 28,
        height: 28,
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
    navSectionLabel: {
        paddingTop: 14,
        paddingHorizontal: spacing.lg,
        paddingBottom: spacing.sm,
        color: brand.onSubtle,
        fontSize: fontSize['2xs'],
        fontWeight: fontWeight.extrabold,
        letterSpacing: 1,
        textTransform: 'uppercase',
    },
    sideNavItem: {
        display: 'flex',
        width: '100%',
        height: 44,
        minHeight: 44,
        flexShrink: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.lg,
        textDecorationLine: 'none',
    } as WebOnlyViewStyle,
    navIconFrame: {
        width: 19,
        height: 19,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    sideNavItemHover: {
        backgroundColor: brand.overlay,
    },
    sideNavItemActive: {
        backgroundColor: colors.primary,
        boxShadow: shadows.brandGlow,
    } as WebOnlyViewStyle,
    sideNavItemDisabled: {
        opacity: 0.64,
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
        minWidth: 18,
        height: 18,
        paddingHorizontal: 5,
        borderRadius: radii.full,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.primary,
    },
    navBadgeActive: {
        backgroundColor: webOverlays.navBadgeActive,
    },
    navBadgeText: {
        fontSize: 10,
        fontWeight: fontWeight.bold,
        color: colors.textWhite,
    },
    bottomNavIconWrap: {
        position: 'relative',
    },
    bottomNavBadge: {
        position: 'absolute',
        top: -5,
        right: -12,
        borderWidth: 1.5,
        borderColor: colors.bgCard,
    },

    sidebarFooter: {
        paddingHorizontal: 14,
        paddingTop: spacing.md,
        borderTopWidth: 1,
        borderTopColor: brand.borderSubtle,
    },
    userChip: {
        minHeight: 50,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
    },
    userChipHover: {
        backgroundColor: brand.overlay,
    },
    userAvatar: {
        width: 34,
        height: 34,
        borderRadius: radii.full,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.primary,
    },
    userAvatarText: {
        color: colors.textWhite,
        fontWeight: fontWeight.extrabold,
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
        gap: spacing.lg,
        paddingHorizontal: spacing.xl,
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
        width: 44,
        height: 44,
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
        minHeight: 44,
        height: 54,
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

    sheetScrim: {
        position: 'fixed',
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 90,
        backgroundColor: webOverlays.sheetScrim,
    } as unknown as WebOnlyViewStyle,
    sheet: {
        backgroundColor: colors.bgCard,
        borderBottomLeftRadius: radii['3xl'],
        borderBottomRightRadius: radii['3xl'],
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        padding: spacing.xl,
        paddingTop: spacing.lg,
        boxShadow: shadows.xl,
    } as WebOnlyViewStyle,
    sheetHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: spacing.md,
    },
    sheetTitle: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: fontSize.lg,
        fontWeight: fontWeight.extrabold,
    },
    sheetClose: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        backgroundColor: colors.bgMuted,
    },
    sheetItem: {
        minHeight: 46,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        borderRadius: radii.md,
        paddingHorizontal: spacing.sm,
    },
    sheetItemText: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: 15,
        fontWeight: fontWeight.bold,
    },
})
