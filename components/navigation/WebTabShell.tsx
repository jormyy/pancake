import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { StackRouter } from '@react-navigation/native'
import { ComponentProps, ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Image, Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native'
import { Link, Navigator, usePathname, useRouter } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { usePendingTradeCount } from '@/hooks/use-pending-trade-count'
import { getJoinableDraft } from '@/lib/draft'
import { getProfile } from '@/lib/auth'
import { Avatar } from '@/components/Avatar'
import { brand, breakpoints, colors, WEB_THEME_VARS } from '@/constants/tokens'
import { styles } from './webTabShellStyles'

type IconName = ComponentProps<typeof MaterialIcons>['name']
type LeagueTab = 'results' | 'auctions' | 'mockRooms' | 'draftBoard' | 'settings' | 'history'
type RouteHref = '/' | '/players' | '/dynasty' | '/roster' | '/trades' | '/league' | '/profile'

const PRIMARY_NAV: { label: string; href: RouteHref; icon: IconName }[] = [
    { label: 'Matchup', href: '/', icon: 'home' },
    { label: 'Players', href: '/players', icon: 'groups' },
{ label: 'Dynasty', href: '/dynasty', icon: 'auto-awesome' },
    { label: 'Roster', href: '/roster', icon: 'assignment' },
    { label: 'Trades', href: '/trades', icon: 'swap-horiz' },
]

const LEAGUE_NAV: { label: string; tab: LeagueTab; icon: IconName }[] = [
    { label: 'Results', tab: 'results', icon: 'emoji-events' },
    { label: 'Auctions', tab: 'auctions', icon: 'attach-money' },
    { label: 'Mock Rooms', tab: 'mockRooms', icon: 'groups' },
    { label: 'Draft Board', tab: 'draftBoard', icon: 'view-list' },
    { label: 'Settings', tab: 'settings', icon: 'settings' },
    { label: 'History', tab: 'history', icon: 'history' },
]

const MOBILE_NAV: { label: string; href: RouteHref; icon: IconName }[] = [
    ...PRIMARY_NAV,
    { label: 'League', href: '/league', icon: 'emoji-events' },
]

const MOBILE_LABELS: Record<RouteHref, string> = {
    '/': 'Match',
    '/players': 'Players',
'/dynasty': 'Dyn',
    '/roster': 'Roster',
    '/trades': 'Trades',
    '/league': 'League',
    '/profile': 'Profile',
}

const SECTION_TITLES: { label: string; href: RouteHref }[] = [
    ...MOBILE_NAV.map(({ label, href }) => ({ label, href })),
    { label: 'Profile', href: '/profile' },
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

function isRouteActive(pathname: string, href: RouteHref) {
    if (href === '/') return pathname === '/' || pathname === '' || pathname === '/index' || pathname === '/(tabs)' || pathname === '/(tabs)/index'
    return pathname.startsWith(href)
}

function injectThemeVariables() {
    if (typeof document === 'undefined' || document.getElementById('pancake-web-theme-vars')) return

    // Generated from the single token source (WEB_THEME_VARS) so the web CSS
    // variables can never drift from constants/tokens.ts. Web is light-only.
    const declarations = Object.entries(WEB_THEME_VARS)
        .map(([name, value]) => `            --pancake-${name}: ${value};`)
        .join('\n')

    const style = document.createElement('style')
    style.id = 'pancake-web-theme-vars'
    style.textContent = `
        :root,
        :root[data-pancake-theme="light"] {
${declarations}
        }
    `
    document.head.appendChild(style)
}

function usePancakeWebTheme() {
    useEffect(() => {
        injectThemeVariables()
        if (typeof document === 'undefined') return
        document.documentElement.setAttribute('data-pancake-theme', 'light')
    }, [])
}

function useDocumentTitle() {
    const pathname = usePathname()
    useEffect(() => {
        if (typeof document === 'undefined') return
        const section = SECTION_TITLES.find((item) => isRouteActive(pathname, item.href))
        document.title = section ? `${section.label} · Pancake` : 'Pancake'
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

function compactHeaderLabel(label: string): string {
    const words = label.trim().split(/\s+/).filter(Boolean)
    return words.length > 2 ? words.slice(0, 2).join(' ') : label
}

function LeagueSwitcher({ tone = 'dark' }: { tone?: 'dark' | 'light' }) {
    const { memberships, current, setCurrent } = useLeagueContext()
    const [open, setOpen] = useState(false)
    const light = tone === 'light'
    const nameStyle = [styles.leagueName, light && styles.leagueNameLight]
    const metaStyle = [styles.leagueMeta, light && styles.leagueMetaLight]
    const chevronColor = light ? colors.textMuted : brand.onMuted
    const labelForTone = (label: string) => light ? compactHeaderLabel(label) : label

    if (!current) {
        return (
            <View style={[styles.leagueSwitch, light && styles.leagueSwitchLight]}>
                <View style={styles.leagueCrest}><Text style={styles.leagueCrestText}>P</Text></View>
                <View style={styles.flex1}>
                    <Text style={nameStyle} numberOfLines={1} ellipsizeMode="clip">No league</Text>
                    <Text style={metaStyle} numberOfLines={1} ellipsizeMode="clip">{labelForTone('Create or join from League')}</Text>
                </View>
            </View>
        )
    }

    const currentLeagueName = current.leagues?.name ?? 'Pancake League'
    const currentTeamName = current.team_name ?? 'Team'

    return (
        <View style={styles.leagueSwitchWrap}>
            <Pressable
                onPress={() => setOpen((value) => !value)}
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
                    <Text style={nameStyle} numberOfLines={1} ellipsizeMode="clip">{labelForTone(currentLeagueName)}</Text>
                    <Text style={metaStyle} numberOfLines={1} ellipsizeMode="clip">{labelForTone(currentTeamName)}</Text>
                </View>
                <MaterialIcons name={open ? 'expand-less' : 'expand-more'} size={18} color={chevronColor} />
            </Pressable>

            {open ? (
                <View style={styles.leagueMenu}>
                    {memberships.map((membership) => {
                        const active = membership.id === current.id
                        return (
                            <Pressable
                                key={membership.id}
                                onPress={() => {
                                    setCurrent(membership)
                                    setOpen(false)
                                }}
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
                                    <Text style={styles.leagueMenuName} numberOfLines={1} ellipsizeMode="clip">{membership.leagues?.name ?? 'League'}</Text>
                                    <Text style={styles.leagueMenuMeta} numberOfLines={1} ellipsizeMode="clip">{membership.team_name ?? 'Team'}</Text>
                                </View>
                                {active ? <MaterialIcons name="check" size={17} color={colors.primary} /> : null}
                            </Pressable>
                        )
                    })}
                </View>
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
    const router = useRouter()

    return (
        <Pressable
            onPress={onPress ?? (href ? () => router.push(href) : undefined)}
            disabled={disabled || loading}
            style={({ hovered, pressed }: PressableState) => [
                styles.sideNavItem,
                active && styles.sideNavItemActive,
                hovered && !active && styles.sideNavItemHover,
                pressed && styles.pressed,
                (disabled || loading) && styles.sideNavItemDisabled,
            ]}
            accessibilityRole="button"
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
}


function useDraftRoomLauncher() {
    const router = useRouter()
    const { currentLeague } = useLeagueContext()
    const [draftLoading, setDraftLoading] = useState(false)

    const openDraftRoom = useCallback(async () => {
        if (!currentLeague?.id || draftLoading) {
            router.push('/draft-room')
            return
        }
        setDraftLoading(true)
        try {
            const draft = await getJoinableDraft(currentLeague.id, {
                includeCompletedRookie: true,
            })
            if (!draft) {
                router.push('/draft-room')
            } else if (draft.draftType === 'snake') {
                router.push({ pathname: '/(modals)/rookie-draft-room', params: { draftId: draft.id } })
            } else {
                router.push({ pathname: '/(modals)/draft-room', params: { draftId: draft.id } })
            }
        } finally {
            setDraftLoading(false)
        }
    }, [currentLeague?.id, draftLoading, router])

    return { openDraftRoom, draftLoading }
}

function WebSidebar() {
    const pathname = usePathname()
    const router = useRouter()
    const { current, isCommissioner } = useLeagueContext()
    const { user } = useAuth()
    const { openDraftRoom, draftLoading } = useDraftRoomLauncher()
    const pendingTradeCount = usePendingTradeCount()
    const [avatarUrl, setAvatarUrl] = useState<string | null>(null)

    useEffect(() => {
        if (!user) return
        getProfile(user.id).then((p) => setAvatarUrl(p.avatar_url ?? null)).catch(() => {})
    }, [user, pathname])

    return (
        <View style={styles.sidebar} role="navigation" aria-label="Primary">
            <ScrollView style={styles.sidebarScroll} contentContainerStyle={styles.sidebarScrollContent}>
                <View style={styles.brandRow}>
                    <BrandMark />
                    <View>
                        <Text style={styles.brandTitle}>Pancake</Text>
                        <Text style={styles.brandSubtitle}>Manager Console</Text>
                    </View>
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
                        active={pathname.startsWith('/league')}
                        href="/league"
                    />
                </View>

                <Text style={styles.navSectionLabel}>Season tools</Text>
                <View style={styles.navGroup}>
                    <SidebarNavButton label="Draft Room" icon="flash-on" onPress={openDraftRoom} loading={draftLoading} />
                    <SidebarNavButton label="Playoffs" icon="account-tree" onPress={() => router.push('/(modals)/bracket')} />
                    {isCommissioner ? (
                        <SidebarNavButton label="Commissioner" icon="admin-panel-settings" onPress={() => router.push('/(modals)/commissioner-settings')} />
                    ) : null}
                </View>
            </ScrollView>

            <View style={styles.sidebarFooter}>
                <Pressable
                    onPress={() => router.push('/profile')}
                    style={({ hovered, pressed }: PressableState) => [
                        styles.userChip,
                        hovered && styles.userChipHover,
                        pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Profile & settings"
                >
                    <Avatar
                        name={current?.team_name ?? user?.email ?? 'P'}
                        size={34}
                        uri={avatarUrl}
                        color={colors.primary}
                        textColor={colors.textWhite}
                    />
                    <View style={styles.flex1}>
                        <Text style={styles.userName} numberOfLines={1}>{current?.team_name ?? 'Profile'}</Text>
                        <Text style={styles.userMeta} numberOfLines={1}>Profile & settings</Text>
                    </View>
                    <MaterialIcons name="settings" size={17} color={brand.onSubtle} />
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
    const { isCommissioner } = useLeagueContext()
    const { openDraftRoom, draftLoading } = useDraftRoomLauncher()
    const menuItems = useMemo(
        () => [
            ...LEAGUE_NAV.map((item) => ({
                key: item.tab,
                label: item.label,
                icon: item.icon,
                onPress: () => router.push(`/league?tab=${item.tab}`),
            })),
            { key: 'draft-room', label: 'Draft Room', icon: 'flash-on' as IconName, onPress: openDraftRoom, loading: draftLoading },
            { key: 'playoffs', label: 'Playoffs', icon: 'account-tree' as IconName, onPress: () => router.push('/(modals)/bracket') },
            ...(isCommissioner
                ? [{ key: 'commissioner', label: 'Commissioner', icon: 'admin-panel-settings' as IconName, onPress: () => router.push('/(modals)/commissioner-settings') }]
                : []),
            { key: 'profile', label: 'Profile & settings', icon: 'settings' as IconName, onPress: () => router.push('/profile') },
        ],
        [draftLoading, isCommissioner, openDraftRoom, router],
    )

    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
            <Pressable style={styles.sheetScrim} onPress={onClose} accessibilityLabel="Close menu">
                <View style={styles.sheet} onStartShouldSetResponder={() => true}>
                    <View style={styles.sheetHeader}>
                        <Text style={styles.sheetTitle}>Menu</Text>
                        <Pressable
                            onPress={onClose}
                            style={styles.sheetClose}
                            accessibilityRole="button"
                            accessibilityLabel="Close menu"
                        >
                            <MaterialIcons name="close" size={20} color={colors.textPrimary} />
                        </Pressable>
                    </View>
                    {menuItems.map((item) => (
                        <Pressable
                            key={item.key}
                            onPress={() => {
                                item.onPress()
                                onClose()
                            }}
                            style={styles.sheetItem}
                            disabled={item.loading}
                            accessibilityRole="button"
                            accessibilityLabel={item.label}
                        >
                            <MaterialIcons name={item.icon} size={21} color={colors.textSecondary} />
                            <Text style={styles.sheetItemText}>{item.label}</Text>
                            <MaterialIcons name="chevron-right" size={20} color={colors.textPlaceholder} />
                        </Pressable>
                    ))}
                </View>
            </Pressable>
        </Modal>
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
