import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { StackRouter } from '@react-navigation/native'
import { ComponentProps, ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { createPortal } from 'react-dom'
import { Link, Navigator, usePathname, useRouter } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { usePendingTradeCount } from '@/hooks/use-pending-trade-count'
import { getProfile } from '@/lib/auth'
import { useBootShellHandoff } from '@/hooks/use-boot-shell-handoff'
import { useDraftRoomLauncher } from '@/hooks/use-draft-room-launcher'
import { Avatar } from '@/components/Avatar'
import { brand, breakpoints, colors, spacing, themeVariablesCss } from '@/constants/tokens'
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
    '/': 'Matchup',
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
const SECTION_CHILDREN: Partial<Record<RouteHref, string[]>> = {
    '/roster': ['/lineup'],
    '/players': ['/player/', '/claim-player'],
    '/trades': ['/propose-trade'],
    '/league': ['/team-roster'],
}

function isRouteActive(pathname: string, href: RouteHref) {
    if ((SECTION_CHILDREN[href] ?? []).some((prefix) => pathname.startsWith(prefix))) return true
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
            resizeMode="contain"
        />
    )
}

function NavIcon({ name, active = false, size = 19 }: { name: IconName; active?: boolean; size?: number }) {
    return (
        <View style={styles.navIconFrame} aria-hidden>
            <MaterialIcons name={name} size={size} color={active ? colors.textWhite : brand.onStrong} />
        </View>
    )
}

function LeagueSwitcher({ tone = 'dark' }: { tone?: 'dark' | 'light' }) {
    const { memberships, current, setCurrent } = useLeagueContext()
    const [open, setOpen] = useState(false)
    const [anchor, setAnchor] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
    const wrapRef = useRef<View>(null)
    const pathname = usePathname()
    const light = tone === 'light'

    // The menu renders in a layer on document.body (this shell is web-only), so
    // nothing in the page can clip it. It sits under the switch; a tap anywhere
    // else closes it without reaching the page, as do Escape and a page change.
    useEffect(() => { setOpen(false) }, [pathname])
    useEffect(() => {
        if (!open || typeof document === 'undefined') return
        const close = () => setOpen(false)
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
        document.addEventListener('keydown', onKey)
        // Browser Back between two tabs of one page keeps the path, so watch history too.
        window.addEventListener('popstate', close)
        return () => {
            document.removeEventListener('keydown', onKey)
            window.removeEventListener('popstate', close)
        }
    }, [open])
    // Read the switch's box straight from the page. The async measure call
    // never answered on a reopen after Escape, which left the menu shut.
    const toggleMenu = () => {
        if (open) { setOpen(false); return }
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
        return (
            <View style={[styles.leagueSwitch, light && styles.leagueSwitchLight]}>
                <View style={styles.leagueCrest}><Text style={styles.leagueCrestText}>P</Text></View>
                <View style={styles.flex1}>
                    <Text style={nameStyle} numberOfLines={1} ellipsizeMode="clip">No league</Text>
                    {light ? null : (
                        <Text style={metaStyle} numberOfLines={1} ellipsizeMode="clip">Create or join from League</Text>
                    )}
                </View>
            </View>
        )
    }

    const currentLeagueName = current.leagues?.name ?? 'Pancake League'
    const currentTeamName = current.team_name ?? 'Team'

    return (
        <View ref={wrapRef} style={[styles.leagueSwitchWrap, light && styles.leagueSwitchWrapLight]}>
            <Pressable
                onPress={toggleMenu}
                style={({ hovered, pressed }: PressableState) => [
                    styles.leagueSwitch,
                    light && styles.leagueSwitchLight,
                    hovered && (light ? styles.leagueSwitchLightHover : styles.leagueSwitchHover),
                    pressed && styles.pressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Switch league"
            >
                <View style={styles.leagueCrest}>
                    <Text style={styles.leagueCrestText}>{(current.team_name ?? 'Team').slice(0, 1).toUpperCase()}</Text>
                </View>
                <View style={styles.flex1}>
                    <Text style={nameStyle} numberOfLines={light ? 1 : 2} ellipsizeMode="tail">{currentLeagueName}</Text>
                    {light ? null : (
                        <Text style={metaStyle} numberOfLines={1} ellipsizeMode="clip">{currentTeamName}</Text>
                    )}
                </View>
                <MaterialIcons name={open ? 'expand-less' : 'expand-more'} size={18} color={chevronColor} />
            </Pressable>

            {open && anchor && typeof document !== 'undefined' ? createPortal(
                <View style={styles.leagueMenuLayer}>
                <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} accessibilityLabel="Close league menu" />
                <View
                    style={[
                        styles.leagueMenu,
                        // Match the switch's width so the menu stays inside the sidebar.
                        { top: anchor.y + anchor.height + spacing.xs, left: anchor.x, width: anchor.width },
                    ]}
                >
                    {memberships.map((membership) => {
                        const active = membership.id === current.id
                        return (
                            <Pressable
                                key={membership.id}
                                onPress={() => {
                                    setCurrent(membership)
                                    setOpen(false)
                                }}
                                accessibilityRole="button"
                                accessibilityLabel={`Switch to ${membership.leagues?.name ?? 'League'}`}
                                style={({ hovered, pressed }: PressableState) => [
                                    styles.leagueMenuItem,
                                    active && styles.leagueMenuItemActive,
                                    hovered && styles.leagueMenuItemHover,
                                    pressed && styles.pressed,
                                ]}
                            >
                                <View style={[styles.leagueCrest, styles.leagueMenuCrest]}>
                                    <Text style={styles.leagueCrestText}>{(membership.team_name ?? 'Team').slice(0, 1).toUpperCase()}</Text>
                                </View>
                                <View style={styles.flex1}>
                                    <Text style={styles.leagueMenuName} numberOfLines={2} ellipsizeMode="tail">{membership.leagues?.name ?? 'League'}</Text>
                                    <Text style={styles.leagueMenuMeta} numberOfLines={1} ellipsizeMode="clip">{membership.team_name ?? 'Team'}</Text>
                                </View>
                                {active ? <MaterialIcons name="check" size={17} color={colors.primary} /> : null}
                            </Pressable>
                        )
                    })}
                </View>
                </View>,
                document.body,
            ) : null}
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
    return href ? <Link href={href} asChild>{button}</Link> : button
}

// Pages opened from Profile keep it marked as the current place.
const PROFILE_ROUTES = ['/profile', '/change-password', '/create-league', '/join-league']
function isProfileRoute(pathname: string) {
    return PROFILE_ROUTES.some((route) => pathname.startsWith(route))
}

function WebSidebar() {
    const pathname = usePathname()
    const profileActive = isProfileRoute(pathname)
    const router = useRouter()
    const { current, currentLeague, isCommissioner } = useLeagueContext()
    const { user } = useAuth()
    const { openDraftRoom, draftLoading } = useDraftRoomLauncher(currentLeague?.id, { notifyOnError: true })
    const pendingTradeCount = usePendingTradeCount()
    const [avatarUrl, setAvatarUrl] = useState<string | null>(null)

    // Keyed on the id: sign-in and token refreshes replace the user object
    // several times, and each replacement re-read the same profile.
    const userId = user?.id
    useEffect(() => {
        if (!userId) return
        let cancelled = false
        getProfile(userId)
            .then((profile) => {
                if (!cancelled) setAvatarUrl(profile.avatar_url ?? null)
            })
            .catch((error) => {
                if (!cancelled) console.error('Could not load sidebar profile', error)
            })
        return () => {
            cancelled = true
        }
    }, [userId])

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
                                label={item.label}
                                icon={item.icon}
                                active={isRouteActive(pathname, item.href)}
                                href={item.href as ComponentProps<typeof Link>['href']}
                                badge={isTrades ? pendingTradeCount : undefined}
                                accessibilityLabel={isTrades ? tradesNavLabel(item.label, pendingTradeCount) : undefined}
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

                <View style={styles.navDivider} aria-hidden />
                <View style={styles.navGroup}>
                    <SidebarNavButton
                        label="Draft Room"
                        icon="flash-on"
                        onPress={openDraftRoom}
                        loading={draftLoading}
                        active={pathname.startsWith('/draft') || pathname.startsWith('/rookie-draft-room')}
                    />
                    <SidebarNavButton label="Playoffs" icon="account-tree" onPress={() => router.push('/(modals)/bracket')} active={pathname.startsWith('/bracket')} />
                    {isCommissioner ? (
                        <SidebarNavButton
                            label="Commissioner"
                            icon="admin-panel-settings"
                            onPress={() => router.push('/(modals)/commissioner-settings')}
                            active={pathname.startsWith('/commissioner-settings')}
                        />
                    ) : null}
                </View>
            </ScrollView>

            <View style={styles.sidebarFooter}>
                <Pressable
                    onPress={() => router.push('/profile')}
                    style={({ hovered, pressed }: PressableState) => [
                        styles.userChip,
                        hovered && !profileActive && styles.userChipHover,
                        profileActive && styles.userChipActive,
                        pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Profile & settings"
                    accessibilityState={{ selected: profileActive }}
                    {...(profileActive ? ARIA_CURRENT_PAGE : null)}
                >
                    <Avatar
                        name={current?.team_name ?? user?.email ?? 'P'}
                        size={34}
                        uri={avatarUrl}
                        color={profileActive ? colors.primaryHover : colors.primary}
                        textColor={colors.textWhite}
                    />
                    <View style={styles.flex1}>
                        <Text style={[styles.userName, profileActive && styles.userTextActive]} numberOfLines={1}>{current?.team_name ?? 'Profile'}</Text>
                        <Text style={[styles.userMeta, profileActive && styles.userTextActive]} numberOfLines={1}>Profile & settings</Text>
                    </View>
                    <MaterialIcons name="settings" size={17} color={profileActive ? brand.on : brand.onSubtle} />
                </Pressable>
            </View>
        </View>
    )
}

function MobileTopBar({ onMenuPress }: { onMenuPress: () => void }) {
    return (
        <View style={styles.mobileTopbar}>
            <BrandMark compact />
            <View style={styles.mobileLeagueWrap}>
                <LeagueSwitcher tone="light" />
            </View>
            <Pressable onPress={onMenuPress} style={styles.mobileMenuButton} accessibilityRole="button" accessibilityLabel="Open menu">
                <MaterialIcons name="menu" size={22} color={colors.textPrimary} />
            </Pressable>
        </View>
    )
}

function MobileBottomNav() {
    const pathname = usePathname()
    const router = useRouter()
    const pendingTradeCount = usePendingTradeCount()

    return (
        <View style={styles.mobileBottomNav} role="navigation" aria-label="Primary">
            {MOBILE_NAV.map((item) => {
                const active = isRouteActive(pathname, item.href)
                const badge = item.href === '/trades' ? pendingTradeCount : 0
                const displayLabel = MOBILE_LABELS[item.href]
                return (
                    <Pressable
                        key={item.href}
                        onPress={() => router.push(item.href)}
                        style={({ pressed }: PressableState) => [styles.bottomNavItem, pressed && styles.pressed]}
                        accessibilityRole="link"
                        accessibilityLabel={item.href === '/trades' ? tradesNavLabel(item.label, pendingTradeCount) : item.label}
                        accessibilityState={{ selected: active }}
                        {...(active ? ARIA_CURRENT_PAGE : null)}
                    >
                        <View style={styles.bottomNavIconWrap} aria-hidden>
                            <MaterialIcons name={item.icon} size={22} color={active ? colors.primary : colors.textMuted} />
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
    const pathname = usePathname()
    const { currentLeague, isCommissioner } = useLeagueContext()
    const { openDraftRoom, draftLoading } = useDraftRoomLauncher(currentLeague?.id, { notifyOnError: true })
    // League sub-tabs are reachable from the League tab's own pill bar — the
    // sheet only carries destinations the bottom bar doesn't already cover.
    const menuItems = useMemo(
        () => [
            {
                key: 'draft-room', label: 'Draft Room', icon: 'flash-on' as IconName, onPress: openDraftRoom, loading: draftLoading,
                active: pathname.startsWith('/draft') || pathname.startsWith('/rookie-draft-room'),
            },
            { key: 'playoffs', label: 'Playoffs', icon: 'account-tree' as IconName, onPress: () => router.push('/(modals)/bracket'), active: pathname.startsWith('/bracket') },
            ...(isCommissioner
                ? [{
                    key: 'commissioner', label: 'Commissioner', icon: 'admin-panel-settings' as IconName,
                    onPress: () => router.push('/(modals)/commissioner-settings'), active: pathname.startsWith('/commissioner-settings'),
                }]
                : []),
            { key: 'profile', label: 'Profile & settings', icon: 'settings' as IconName, onPress: () => router.push('/profile'), active: isProfileRoute(pathname) },
        ],
        [draftLoading, isCommissioner, openDraftRoom, pathname, router],
    )

    return (
        <Sheet visible={visible} title="Menu" onClose={onClose}>
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
                    <MaterialIcons name={item.icon} size={21} color={item.active ? colors.primaryDark : colors.textSecondary} />
                    <Text style={[styles.sheetItemText, item.active && styles.sheetItemTextActive]}>{item.label}</Text>
                    <MaterialIcons name="chevron-right" size={20} color={colors.textPlaceholder} />
                </Pressable>
            ))}
        </Sheet>
    )
}

/**
 * The persistent web app-shell: sidebar (wide) or mobile top/bottom nav
 * (compact) wrapping a content area. Mounted ONCE at the root for every
 * authenticated route, so the navigation chrome never disappears — including
 * during the draft, lineup, trades, and on player detail. Former full-screen
 * `(modals)` takeovers now render as pages inside this content area.
 */
export function WebAppShell({ children, chrome = true }: { children: ReactNode; chrome?: boolean }) {
    const { width } = useWindowDimensions()
    const compact = width < breakpoints.compact
    usePancakeWebTheme()
    useDocumentTitle()
    // Swap the static boot shell for this one before the first paint.
    useBootShellHandoff()
    const [menuOpen, setMenuOpen] = useState(false)

    // Keep the shell mounted for ALL web routes (stable element type) so toggling
    // chrome on auth state change never remounts the route tree. Auth/loading
    // routes render chrome-less.
    if (!chrome) return <>{children}</>

    return (
        <View style={[styles.root, compact ? styles.rootCompact : styles.rootDesktop]}>
            {compact ? <MobileTopBar onMenuPress={() => setMenuOpen(true)} /> : <WebSidebar />}
            <View style={[styles.content, compact && styles.contentCompact]} role="main">{children}</View>
            {compact ? (
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
