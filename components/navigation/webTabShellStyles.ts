import { StyleSheet } from 'react-native'
import type { ViewStyle } from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

const SIDEBAR_WIDTH = 248
const MOBILE_TOPBAR_HEIGHT = 56
const MOBILE_BOTTOMBAR_HEIGHT = 64

// react-native-web supports these CSS properties at runtime, but React
// Native's bundled ViewStyle types don't model them. This stays an
// intersection with ViewStyle so the styles remain assignable to
// StyleSheet.create. Note: `position: 'fixed' | 'sticky'` can't be added
// here — intersecting collapses position back to ViewStyle['position'], and
// widening it would make WebOnlyViewStyle no longer assignable to ViewStyle.
// The few fixed-position styles below are cast through `unknown` instead.
type WebOnlyViewStyle = ViewStyle & {
    backdropFilter?: string
    WebkitBackdropFilter?: string
    boxShadow?: string
}

export const styles = StyleSheet.create({
    root: {
        flex: 1,
        minHeight: '100%',
        backgroundColor: colors.bgScreen,
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
        backgroundColor: '#2A1A0E',
        paddingBottom: 14,
        borderRightWidth: 1,
        borderRightColor: 'rgba(0, 0, 0, 0.24)',
    },
    sidebarScroll: {
        flex: 1,
    },
    sidebarScrollContent: {
        paddingHorizontal: 14,
        paddingTop: 18,
        gap: spacing.sm,
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
        width: 38,
        height: 38,
        borderRadius: 11,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 4px 12px rgba(201, 102, 15, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.3)',
    } as WebOnlyViewStyle,
    brandMarkCompact: {
        width: 34,
        height: 34,
        borderRadius: 9,
        boxShadow: 'none', // the glow bleeds into the league switcher on the light top bar
    } as WebOnlyViewStyle,
    brandMarkText: {
        color: '#FFF6E8',
        fontSize: 20,
        fontWeight: fontWeight.extrabold,
    },
    brandMarkTextCompact: {
        fontSize: 17,
    },
    brandTitle: {
        fontSize: 19,
        fontWeight: fontWeight.extrabold,
        color: '#FFF6E8',
        letterSpacing: -0.4,
    },
    brandSubtitle: {
        marginTop: -2,
        fontSize: 10,
        fontWeight: fontWeight.bold,
        letterSpacing: 1.5,
        textTransform: 'uppercase',
        color: '#A9876B',
    },

    leagueSwitchWrap: {
        position: 'relative',
        zIndex: 20,
        marginBottom: spacing.md,
    },
    leagueSwitch: {
        minHeight: 52,
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        borderRadius: radii.md,
        backgroundColor: 'rgba(255, 255, 255, 0.06)',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.08)',
    },
    leagueSwitchHover: {
        backgroundColor: 'rgba(255, 255, 255, 0.10)',
    },
    leagueCrest: {
        width: 30,
        height: 30,
        borderRadius: radii.md,
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
        color: '#E8D2B8',
        fontWeight: fontWeight.bold,
        fontSize: fontSize.sm,
    },
    leagueMeta: {
        color: '#A9876B',
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
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgCard,
        boxShadow: '0 16px 44px rgba(74, 37, 9, 0.16), 0 4px 12px rgba(74, 37, 9, 0.08)',
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
        color: '#A9876B',
        fontSize: 10,
        fontWeight: fontWeight.extrabold,
        letterSpacing: 1.4,
        textTransform: 'uppercase',
    },
    sideNavItem: {
        display: 'flex',
        width: '100%',
        minHeight: 40,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.md,
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
        backgroundColor: 'rgba(255, 255, 255, 0.06)',
    },
    sideNavItemActive: {
        backgroundColor: colors.primary,
        boxShadow: '0 4px 12px rgba(201, 102, 15, 0.4)',
    } as WebOnlyViewStyle,
    sideNavItemDisabled: {
        opacity: 0.64,
    },
    sideNavText: {
        flex: 1,
        color: '#E8D2B8',
        fontSize: fontSize.md,
        fontWeight: fontWeight.semibold,
    },
    sideNavTextActive: {
        color: '#FFF6E8',
    },

    sidebarFooter: {
        paddingHorizontal: 14,
        paddingTop: spacing.md,
        borderTopWidth: 1,
        borderTopColor: 'rgba(255, 255, 255, 0.06)',
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
        backgroundColor: 'rgba(255, 255, 255, 0.06)',
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
        color: '#E8D2B8',
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
    },
    userMeta: {
        color: '#A9876B',
        fontSize: fontSize.xs,
    },

    content: {
        flex: 1,
        minWidth: 0,
        backgroundColor: colors.bgScreen,
    },
    contentCompact: {
        paddingTop: MOBILE_TOPBAR_HEIGHT,
        paddingBottom: MOBILE_BOTTOMBAR_HEIGHT,
    },

    mobileTopbar: {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        height: MOBILE_TOPBAR_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.lg,
        paddingHorizontal: spacing.xl,
        backgroundColor: 'rgba(253, 248, 238, 0.88)',
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    } as unknown as WebOnlyViewStyle,
    mobileLeagueWrap: {
        flex: 1,
        minWidth: 0,
    },
    mobileMenuButton: {
        width: 44,
        height: 44,
        borderRadius: radii.md,
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
        height: MOBILE_BOTTOMBAR_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-around',
        paddingBottom: spacing.xs,
        backgroundColor: colors.bgCard,
        borderTopWidth: 1,
        borderTopColor: colors.borderLight,
        boxShadow: '0 -6px 24px rgba(74, 37, 9, 0.10)',
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
        fontSize: 10,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
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
        backgroundColor: 'rgba(44, 26, 14, 0.42)',
    } as unknown as WebOnlyViewStyle,
    sheet: {
        backgroundColor: colors.bgCard,
        borderBottomLeftRadius: radii['2xl'],
        borderBottomRightRadius: radii['2xl'],
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        padding: spacing.xl,
        paddingTop: spacing.lg,
        boxShadow: '0 18px 48px rgba(74, 37, 9, 0.20)',
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
