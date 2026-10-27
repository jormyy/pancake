import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { StackRouter } from '@react-navigation/native'
import { ComponentProps, type PropsWithChildren, useCallback, useEffect, useRef, useState } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native'
import { createPortal } from 'react-dom'
import { Link, Navigator, useGlobalSearchParams, usePathname, useRouter } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { usePendingTradeCount } from '@/hooks/use-pending-trade-count'
import { useBootShellHandoff } from '@/hooks/use-boot-shell-handoff'
import { brand, breakpoints, colors, controlSize, spacing, themeVariablesCss } from '@/constants/tokens'
import { hasShellBackHeader, SHELL_SECTION_CHILDREN } from '@/constants/navigation'
import { Sheet } from '@/components/ui/Sheet'
import { styles } from './webTabShellStyles'

type IconName = ComponentProps<typeof MaterialIcons>['name']
type RouteHref = '/' | '/players' | '/roster' | '/trades' | '/league' | '/profile'

const PRIMARY_NAV: { label: string; href: RouteHref; icon: IconName }[] = [
    { label: 'Matchup', href: '/', icon: 'home' },
    { label: 'Roster', href: '/roster', icon: 'assignment' },
    { label: 'Players', href: '/players', icon: 'groups' },
    { label: 'Trades', href: '/trades', icon: 'swap-horiz' },
]

const MOBILE_NAV: { label: string; href: RouteHref; icon: IconName }[] = [
    ...PRIMARY_NAV,
    { label: 'League', href: '/league', icon: 'emoji-events' },
]

const MOBILE_LABELS: Record<RouteHref, string> = {
    '/': 'Home',
    '/players': 'Players',
    '/roster': 'Roster',
    '/trades': 'Trades',
    '/league': 'League',
    '/profile': 'Profile',
}

const SECTION_TITLES: { label: string; href: RouteHref }[] = [
    ...MOBILE_NAV.map(({ label, href }) => ({ label, href })),
    { label: 'Profile', href: '/profile' },
]

// Pages opened on top of a section name themselves in the browser tab.
const PAGE_TITLES: { prefix: string; label: string }[] = [
    { prefix: '/timeline', label: 'Season timeline' },
    { prefix: '/lineup', label: 'Lineup' },
    { prefix: '/claim-player', label: 'Waiver Claim' },
    { prefix: '/propose-trade', label: 'Propose Trade' },
    { prefix: '/team-roster', label: 'Team Roster' },
    { prefix: '/player/', label: 'Player' },
    { prefix: '/bracket', label: 'Playoffs' },
    { prefix: '/commissioner-settings', label: 'League Settings' },
    { prefix: '/create-league', label: 'Create League' },
    { prefix: '/join-league', label: 'Join League' },
    { prefix: '/change-password', label: 'Change Password' },
    { prefix: '/notification-settings', label: 'Notifications' },
    { prefix: '/rookie-draft-room', label: 'Rookie Draft' },
    { prefix: '/draft', label: 'Draft Room' },
]

// react-native-web forwards aria-* props to the DOM, but React Native's prop
// types don't model aria-current — spread this constant so the active nav item
// emits a real signal for assistive tech (accessibilityState.selected is not
// mapped to aria for role=button on web).
const ARIA_CURRENT_PAGE = { 'aria-current': 'page' } as const

const webStackRouter: typeof StackRouter = (options) => {
    const router = StackRouter(options)

    return {
        ...router,
        getRehydratedState(partialState, routeOptions) {
            if (partialState == null) {
                return router.getInitialState(routeOptions)
            }
            return router.getRehydratedState(partialState, routeOptions)
        },
    }
}

type PressableState = { hovered?: boolean; pressed?: boolean }

function tradesNavLabel(label: string, pendingCount: number) {
    if (pendingCount <= 0) return label
    return `${label}, ${pendingCount} pending offer${pendingCount === 1 ? '' : 's'}`
}

// Screens opened on top of a section keep that section lit in the navigation.
function isRouteActive(pathname: string, href: RouteHref) {
    if (href === '/league' && ['/profile', '/notification-settings', '/change-password', '/create-league', '/join-league', '/draft', '/rookie-draft-room', '/bracket', '/commissioner-settings', '/timeline'].some(route => pathname === route || pathname.startsWith(`${route}/`))) return true
    if ((SHELL_SECTION_CHILDREN[href] ?? []).some((prefix) => pathname.startsWith(prefix))) return true
    if (href === '/') return pathname === '/' || pathname === '' || pathname === '/index' || pathname === '/(tabs)' || pathname === '/(tabs)/index'
    return pathname.startsWith(href)
}

function injectThemeVariables() {
    if (typeof document === 'undefined' || document.getElementById('pancake-web-theme-vars')) return

    // Generated from the single token source so the web CSS variables can never
    // drift from constants/tokens.ts. Dark values apply when the system asks.
    const style = document.createElement('style')
    style.id = 'pancake-web-theme-vars'
    style.textContent = themeVariablesCss()
    document.head.appendChild(style)
}

function usePancakeWebTheme() {
    useEffect(() => {
        injectThemeVariables()
    }, [])
}

function useDocumentTitle() {
    const pathname = usePathname()
    useEffect(() => {
        if (typeof document === 'undefined') return
        const label = PAGE_TITLES.find((item) => pathname.startsWith(item.prefix))?.label ??
            SECTION_TITLES.find((item) => isRouteActive(pathname, item.href))?.label
        document.title = label ? `${label} · Pancake` : 'Pancake'
    }, [pathname])
}

function BrandMark({ compact = false }: { compact?: boolean }) {
    return (
        <Image
            source={require('@/assets/images/pancake_logo.png')}
            style={compact ? styles.brandMarkCompact : styles.brandMark}
            testID={compact ? 'pancake-brand' : undefined}
            resizeMode="contain"
        />
    )
}

function NavIcon({ name, active = false, size = controlSize.icon.md }: { name: IconName; active?: boolean; size?: number }) {
    return (
        <View style={styles.navIconFrame} aria-hidden>
            <MaterialIcons name={name} size={size} color={active ? colors.textWhite : brand.onStrong} />
        </View>
    )
}

function LeagueSwitcher({ tone = 'dark' }: { tone?: 'dark' | 'light' }) {
    const { memberships, current, setCurrent, membershipStatus } = useLeagueContext()
    const { height: viewportHeight } = useWindowDimensions()
    const [open, setOpen] = useState(false)
    const [anchor, setAnchor] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
    const wrapRef = useRef<View>(null)
    const triggerRef = useRef<View>(null)
    const activeOptionRef = useRef<View>(null)
    const menuRef = useRef<ScrollView>(null)
    const pathname = usePathname()
    const light = tone === 'light'
    const router = useRouter()
    const [joining, setJoining] = useState(false)
    const closeMenu = useCallback(() => {
        setOpen(false)
        triggerRef.current?.focus()
    }, [])

    // The menu renders in a layer on document.body (this shell is web-only), so
    // nothing in the page can clip it. It sits under the switch; a tap anywhere
    // else closes it without reaching the page, as do Escape and a page change.
    useEffect(() => { setOpen(false); setJoining(false) }, [pathname])
    useEffect(() => {
        if (!open || typeof document === 'undefined') return
        activeOptionRef.current?.focus()
        const close = () => setOpen(false)
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault()
                closeMenu()
            } else if (event.key === 'Tab') {
                const menu = menuRef.current?.getInnerViewNode() as HTMLElement | null
                const options = menu?.querySelectorAll<HTMLElement>('[role="button"]')
                if (!options?.length) return
                const first = options[0]
                const last = options[options.length - 1]
                if (!menu?.contains(document.activeElement) ||
                    (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
                    event.preventDefault()
                    const target = event.shiftKey ? last : first
                    target.focus()
                }
            }
        }
        document.addEventListener('keydown', onKey)
        // Browser Back between two tabs of one page keeps the path, so watch history too.
        window.addEventListener('popstate', close)
        return () => {
            document.removeEventListener('keydown', onKey)
            window.removeEventListener('popstate', close)
        }
    }, [closeMenu, open])
    // Read the switch's box straight from the page. The async measure call
    // never answered on a reopen after Escape, which left the menu shut.
    const toggleMenu = () => {
        if (open) { closeMenu(); return }
        const node = wrapRef.current as unknown as HTMLElement | null
        if (!node?.getBoundingClientRect) return
        const { left, top, width, height } = node.getBoundingClientRect()
        setAnchor({ x: left, y: top, width, height })
        setOpen(true)
    }
    const nameStyle = [styles.leagueName, light && styles.leagueNameLight]
    const metaStyle = [styles.leagueMeta, light && styles.leagueMetaLight]
    const chevronColor = light ? colors.textMuted : brand.onMuted

    if (!current) {
        const waiting = membershipStatus !== 'empty' && membershipStatus !== 'unavailable'
        return (
            <View style={[styles.leagueSwitchWrap, light && styles.leagueSwitchWrapLight]}>
                <View style={[styles.leagueSwitch, light && styles.leagueSwitchLight]} aria-busy={waiting} accessibilityState={{ busy: waiting }}>
                    <View style={styles.flex1}>
                        <Text style={nameStyle} numberOfLines={1} ellipsizeMode="clip" aria-hidden={waiting}>{waiting ? '\u00a0' : membershipStatus === 'empty' ? 'No league' : 'League unavailable'}</Text>
                        {light ? null : (
                            <Text style={metaStyle} numberOfLines={1} ellipsizeMode="clip" aria-hidden={waiting}>{waiting ? '\u00a0' : membershipStatus === 'empty' ? 'Create or join from League' : 'Waiting for league access'}</Text>
                        )}
                    </View>
                </View>
            </View>
        )
    }

    const currentLeagueName = current.leagues?.name ?? 'Pancake League'
    const currentTeamName = current.team_name ?? 'Team'

    return (
        <View ref={wrapRef} style={[styles.leagueSwitchWrap, light && styles.leagueSwitchWrapLight]}>
            <Pressable
                ref={triggerRef}
                onPress={toggleMenu}
                style={({ hovered, pressed }: PressableState) => [
                    styles.leagueSwitch,
                    light && styles.leagueSwitchLight,
                    hovered && (light ? styles.leagueSwitchLightHover : styles.leagueSwitchHover),
                    pressed && styles.pressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Switch league"
                aria-expanded={open}
            >
                <View style={styles.flex1}>
                    <Text style={nameStyle}>{currentLeagueName}</Text>
                    {light ? null : (
                        <Text style={metaStyle} numberOfLines={1} ellipsizeMode="clip">{currentTeamName}</Text>
                    )}
                </View>
                <MaterialIcons name={open ? 'expand-less' : 'expand-more'} size={controlSize.icon.md} color={chevronColor} />
            </Pressable>

            {open && anchor && typeof document !== 'undefined' ? createPortal(
                <View style={styles.leagueMenuLayer}>
                <Pressable style={StyleSheet.absoluteFill} onPress={closeMenu} accessibilityLabel="Close league menu" />
                <ScrollView
                    ref={menuRef}
                    contentContainerStyle={{ padding: spacing.sm }}
                    style={[
                        styles.leagueMenu,
                        // Match the switch's width so the menu stays inside the sidebar.
                        {
                            top: anchor.y + anchor.height + spacing.xs,
                            left: anchor.x,
                            width: anchor.width,
                            maxHeight: Math.max(0, viewportHeight - anchor.y - anchor.height - spacing.xs - spacing.sm),
                        },
                    ]}
                >
                    {memberships.map((membership) => {
                        const active = membership.id === current.id
                        return (
                            <Pressable
                                key={membership.id}
                                ref={active ? activeOptionRef : undefined}
                                onPress={() => {
                                    setCurrent(membership)
                                    closeMenu()
                                }}
                                accessibilityRole="button"
                                accessibilityLabel={`Switch to ${membership.leagues?.name ?? 'League'}`}
                                accessibilityState={{ selected: active }}
                                style={({ hovered, pressed }: PressableState) => [
                                    styles.leagueMenuItem,
                                    active && styles.leagueMenuItemActive,
                                    hovered && styles.leagueMenuItemHover,
                                    pressed && styles.pressed,
                                ]}
                            >
                                <View style={styles.flex1}>
                                    <Text style={styles.leagueMenuName} numberOfLines={2} ellipsizeMode="tail">{membership.leagues?.name ?? 'League'}</Text>
                                    <Text style={styles.leagueMenuMeta} numberOfLines={1} ellipsizeMode="clip">{membership.team_name ?? 'Team'}</Text>
                                </View>
                                {active ? <MaterialIcons name="check" size={controlSize.icon.sm} color={colors.primary} /> : null}
                            </Pressable>
                        )
                    })}
                    <Pressable style={styles.leagueMenuItem} accessibilityRole="button" accessibilityLabel="Join or create a league"
                        onPress={() => { closeMenu(); setJoining(true) }}>
                        <MaterialIcons name="add" size={controlSize.icon.sm} color={colors.primary} />
                        <Text style={[styles.leagueMenuName, styles.flex1]}>Join or create a league</Text>
                    </Pressable>
                </ScrollView>
                </View>,
                document.body,
            ) : null}
            <Sheet visible={joining} accessibilityLabel="Join or create a league" onClose={() => setJoining(false)}>
                <Pressable style={styles.leagueMenuItem} accessibilityRole="button" accessibilityLabel="Join with Invite Code"
                    onPress={() => { setJoining(false); router.push('/(modals)/join-league') }}>
                    <Text style={styles.leagueMenuName}>Join with Invite Code</Text>
                </Pressable>
                <Pressable style={styles.leagueMenuItem} accessibilityRole="button" accessibilityLabel="Create a League"
                    onPress={() => { setJoining(false); router.push('/(modals)/create-league') }}>
                    <Text style={styles.leagueMenuName}>Create a League</Text>
                </Pressable>
            </Sheet>
        </View>
    )
}

function SidebarNavButton({
    label,
    icon,
    active,
    onPress,
    href,
    disabled = false,
    loading = false,
    badge,
    accessibilityLabel,
}: {
    label: string
    icon: IconName
    active?: boolean
    onPress?: () => void
    href?: ComponentProps<typeof Link>['href']
    disabled?: boolean
    loading?: boolean
    badge?: number
    accessibilityLabel?: string
}) {
    // Expo Router's asChild slot flattens styles before Pressable can evaluate a style callback.
    const [hovered, setHovered] = useState(false)
    const [pressed, setPressed] = useState(false)
    const button = (
        <Pressable
            onPress={onPress}
            onHoverIn={() => setHovered(true)}
            onHoverOut={() => setHovered(false)}
            onPressIn={() => setPressed(true)}
            onPressOut={() => setPressed(false)}
            disabled={disabled || loading}
            style={StyleSheet.flatten([
                styles.sideNavItem,
                active && styles.sideNavItemActive,
                hovered && !active && styles.sideNavItemHover,
                pressed && styles.pressed,
                (disabled || loading) && styles.sideNavItemDisabled,
            ])}
            accessibilityRole={href ? 'link' : 'button'}
            accessibilityLabel={accessibilityLabel ?? label}
            accessibilityState={{ selected: active, disabled: disabled || loading }}
            {...(active ? ARIA_CURRENT_PAGE : null)}
        >
            <NavIcon name={icon} active={active} />
            <Text style={[styles.sideNavText, active && styles.sideNavTextActive]} numberOfLines={1}>{label}</Text>
            {typeof badge === 'number' && badge > 0 ? (
                <View style={[styles.navBadge, active && styles.navBadgeActive]} aria-hidden>
                    <Text style={styles.navBadgeText}>{badge}</Text>
                </View>
            ) : null}
        </Pressable>
    )
    return href ? <Link href={href} dismissTo asChild>{button}</Link> : button
}

function WebSidebar() {
    const pathname = usePathname()
    const pendingTradeCount = usePendingTradeCount()

    return (
        <View style={styles.sidebar} role="navigation" aria-label="Primary">
            <ScrollView style={styles.sidebarScroll} contentContainerStyle={styles.sidebarScrollContent}>
                <View style={styles.brandRow}>
                    <BrandMark />
                    <Text style={styles.brandTitle}>Pancake</Text>
                </View>

                <LeagueSwitcher />

                <View style={styles.navGroup}>
                    {PRIMARY_NAV.map((item) => {
                        const isTrades = item.href === '/trades'
                        return (
                            <SidebarNavButton
                                key={item.href}
                                label={item.href === '/' ? 'Home' : item.label}
                                icon={item.icon}
                                active={isRouteActive(pathname, item.href)}
                                href={item.href as ComponentProps<typeof Link>['href']}
                                badge={isTrades ? pendingTradeCount : undefined}
                                accessibilityLabel={isTrades ? tradesNavLabel(item.label, pendingTradeCount) : item.label}
                            />
                        )
                    })}
                </View>

                <View style={styles.navGroup}>
                    <SidebarNavButton
                        label="League"
                        icon="emoji-events"
                        active={isRouteActive(pathname, '/league')}
                        href="/league"
                    />
                </View>

            </ScrollView>
        </View>
    )
}

function MobileTopBar({ onMenuPress }: { onMenuPress: () => void }) {
    useEffect(() => () => {
        if (typeof document !== 'undefined') document.documentElement.style.removeProperty('--pancake-mobile-topbar-height')
    }, [])
    const measure = (event: LayoutChangeEvent) => {
        if (typeof document !== 'undefined') document.documentElement.style.setProperty('--pancake-mobile-topbar-height', `${event.nativeEvent.layout.height}px`)
    }
    return (
        <View style={styles.mobileTopbar} onLayout={measure} testID="mobile-topbar">
            <BrandMark compact />
            <View style={styles.mobileLeagueWrap}>
                <LeagueSwitcher tone="light" />
            </View>
            <Pressable onPress={onMenuPress} style={styles.mobileMenuButton} accessibilityRole="button" accessibilityLabel="Open menu">
                <MaterialIcons name="menu" size={controlSize.icon.md} color={colors.textPrimary} />
            </Pressable>
        </View>
    )
}

function MobileBottomNav() {
    const pathname = usePathname()
    const params = useGlobalSearchParams<{ tradeId?: string | string[] }>()
    const router = useRouter()
    const pendingTradeCount = usePendingTradeCount()

    return (
        <View style={styles.mobileBottomNav} role="navigation" aria-label="Primary">
            {MOBILE_NAV.map((item) => {
                const active = isRouteActive(pathname, item.href)
                const atDestination = (item.href === '/' ? active : pathname === item.href) && !hasShellBackHeader(pathname, params)
                const badge = item.href === '/trades' ? pendingTradeCount : 0
                const displayLabel = MOBILE_LABELS[item.href]
                return (
                    <Pressable
                        key={item.href}
                        onPress={() => { if (!atDestination) router.dismissTo(item.href) }}
                        style={({ pressed }: PressableState) => [styles.bottomNavItem, pressed && styles.pressed]}
                        accessibilityRole="link"
                        accessibilityLabel={item.href === '/trades' ? tradesNavLabel(item.label, pendingTradeCount) : item.label}
                        accessibilityState={{ selected: active }}
                        {...(active ? ARIA_CURRENT_PAGE : null)}
                    >
                        <View style={styles.bottomNavIconWrap} aria-hidden>
                            <MaterialIcons name={item.icon} size={controlSize.icon.lg} color={active ? colors.primary : colors.textMuted} />
                            {badge > 0 ? (
                                <View style={[styles.navBadge, styles.bottomNavBadge]}>
                                    <Text style={styles.navBadgeText}>{badge}</Text>
                                </View>
                            ) : null}
                        </View>
                        <Text style={[styles.bottomNavText, active && styles.bottomNavTextActive]} numberOfLines={1} ellipsizeMode="clip">
                            {displayLabel}
                        </Text>
                    </Pressable>
                )
            })}
        </View>
    )
}

function MobileMenuSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const router = useRouter()
    const menuItems = [{ key: 'league', label: 'League', icon: 'emoji-events' as IconName,
        onPress: () => router.dismissTo('/league'), active: false, loading: false }]

    return (
        <Sheet visible={visible} accessibilityLabel="Menu" onClose={onClose}>
            {menuItems.map((item) => (
                <Pressable
                    key={item.key}
                    onPress={() => {
                        item.onPress()
                        onClose()
                    }}
                    style={[styles.sheetItem, item.active && styles.sheetItemActive]}
                    disabled={item.loading}
                    accessibilityRole="button"
                    accessibilityLabel={item.label}
                    accessibilityState={{ selected: item.active }}
                    {...(item.active ? ARIA_CURRENT_PAGE : null)}
                >
                    <MaterialIcons name={item.icon} size={controlSize.icon.md} color={item.active ? colors.primaryDark : colors.textSecondary} />
                    <Text style={[styles.sheetItemText, item.active && styles.sheetItemTextActive]}>{item.label}</Text>
                    <MaterialIcons name="chevron-right" size={controlSize.icon.md} color={colors.textPlaceholder} />
                </Pressable>
            ))}
        </Sheet>
    )
}

export function WebAppShell({ children, chrome = true }: PropsWithChildren<{ chrome?: boolean }>) {
    const { width } = useWindowDimensions()
    const compact = width < breakpoints.compact
    const pathname = usePathname()
    const params = useGlobalSearchParams<{ tradeId?: string | string[] }>()
    const backHeader = hasShellBackHeader(pathname, params) || pathname === '/timeline'
    usePancakeWebTheme()
    useDocumentTitle()
    // Swap the static boot shell for this one before the first paint.
    useBootShellHandoff()
    const [menuOpen, setMenuOpen] = useState(false)

    // Keep the shell mounted for ALL web routes (stable element type) so toggling
    // chrome on auth state change never remounts the route tree. Auth/loading
    // routes render chrome-less.
    return (
        <View style={chrome ? [styles.root, compact ? styles.rootCompact : styles.rootDesktop] : styles.flex1}>
            {chrome ? (compact ? (backHeader ? null : <MobileTopBar onMenuPress={() => setMenuOpen(true)} />) : <WebSidebar />) : null}
            <View key="route-content" style={chrome ? [styles.content, compact && styles.contentCompact, compact && backHeader && styles.contentWithBackHeader] : styles.flex1} role={chrome ? 'main' : undefined}>{children}</View>
            {chrome && compact ? (
                <>
                    <MobileBottomNav />
                    <MobileMenuSheet visible={menuOpen} onClose={() => setMenuOpen(false)} />
                </>
            ) : null}
        </View>
    )
}

/**
 * The `(tabs)` web layout has no web tab navigator. The chrome lives in
 * WebAppShell at the root and drives links directly, so a Slot avoids the hidden
 * BottomTabNavigator rehydrating stale nested state during auth redirects.
 */
export default function WebTabsLayout() {
    return (
        <Navigator router={webStackRouter} initialRouteName="index">
            <Navigator.Screen name="index" />
            <Navigator.Screen name="players" />
<Navigator.Screen name="dynasty" />
            <Navigator.Screen name="roster" />
            <Navigator.Screen name="trades" />
            <Navigator.Screen name="league" />
            <Navigator.Screen name="profile" />
            <Navigator.Slot />
        </Navigator>
    )
}
