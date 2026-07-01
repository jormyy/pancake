import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { StackRouter } from '@react-navigation/native'
import { ComponentProps, ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native'
import { Link, Navigator, usePathname, useRouter } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { getJoinableDraft } from '@/lib/draft'
import { breakpoints, colors, WEB_THEME_VARS } from '@/constants/tokens'
import { styles } from './webTabShellStyles'

type IconName = ComponentProps<typeof MaterialIcons>['name']
type LeagueTab = 'standings' | 'activity' | 'waivers' | 'picks'
type RouteHref = '/' | '/players' | '/dynasty' | '/roster' | '/trades' | '/league' | '/profile'

const PRIMARY_NAV: { label: string; href: RouteHref; icon: IconName }[] = [
    { label: 'Matchup', href: '/', icon: 'home' },
    { label: 'Players', href: '/players', icon: 'groups' },
    { label: 'Dynasty', href: '/dynasty', icon: 'auto-awesome' },
    { label: 'Roster', href: '/roster', icon: 'assignment' },
    { label: 'Trades', href: '/trades', icon: 'swap-horiz' },
]

const LEAGUE_NAV: { label: string; tab: LeagueTab; icon: IconName }[] = [
    { label: 'Standings', tab: 'standings', icon: 'emoji-events' },
    { label: 'Activity', tab: 'activity', icon: 'bolt' },
    { label: 'Waivers', tab: 'waivers', icon: 'schedule' },
    { label: 'Picks', tab: 'picks', icon: 'style' },
]

const MOBILE_NAV: { label: string; href: RouteHref; icon: IconName }[] = [
    ...PRIMARY_NAV,
    { label: 'League', href: '/league', icon: 'emoji-events' },
]

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

function BrandMark({ compact = false }: { compact?: boolean }) {
    return (
        <View style={[styles.brandMark, compact && styles.brandMarkCompact]}>
            <Text style={[styles.brandMarkText, compact && styles.brandMarkTextCompact]}>P</Text>
        </View>
    )
}

function NavIcon({ name, active = false, size = 19 }: { name: IconName; active?: boolean; size?: number }) {
    return (
        <View style={styles.navIconFrame}>
            <MaterialIcons name={name} size={size} color={active ? colors.textWhite : 'rgba(255, 246, 232, 0.82)'} />
        </View>
    )
}

function LeagueSwitcher({ tone = 'dark' }: { tone?: 'dark' | 'light' }) {
    const { memberships, current, setCurrent } = useLeagueContext()
    const [open, setOpen] = useState(false)
    const light = tone === 'light'
    const nameStyle = [styles.leagueName, light && styles.leagueNameLight]
    const metaStyle = [styles.leagueMeta, light && styles.leagueMetaLight]
    const chevronColor = light ? colors.textMuted : 'rgba(255, 246, 232, 0.7)'

    if (!current) {
        return (
            <View style={[styles.leagueSwitch, light && styles.leagueSwitchLight]}>
                <View style={styles.leagueCrest}><Text style={styles.leagueCrestText}>P</Text></View>
                <View style={styles.flex1}>
                    <Text style={nameStyle} numberOfLines={1}>No league</Text>
                    <Text style={metaStyle} numberOfLines={1}>Create or join from League</Text>
                </View>
            </View>
        )
    }

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
                    <Text style={nameStyle} numberOfLines={1}>{current.leagues?.name ?? 'Pancake League'}</Text>
                    <Text style={metaStyle} numberOfLines={1}>{current.team_name ?? 'Team'}</Text>
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
                                    <Text style={styles.leagueMenuName} numberOfLines={1}>{membership.leagues?.name ?? 'League'}</Text>
                                    <Text style={styles.leagueMenuMeta} numberOfLines={1}>{membership.team_name ?? 'Team'}</Text>
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
}: {
    label: string
    icon: IconName
    active?: boolean
    onPress?: () => void
    href?: ComponentProps<typeof Link>['href']
    disabled?: boolean
    loading?: boolean
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
            accessibilityLabel={label}
            accessibilityState={{ selected: active, disabled: disabled || loading }}
        >
            {loading ? <ActivityIndicator size="small" color="rgba(255, 246, 232, 0.82)" /> : <NavIcon name={icon} active={active} />}
            <Text style={[styles.sideNavText, active && styles.sideNavTextActive]} numberOfLines={1}>{label}</Text>
        </Pressable>
    )
}


function useDraftRoomLauncher() {
    const router = useRouter()
    const { currentLeague } = useLeagueContext()
    const [draftLoading, setDraftLoading] = useState(false)

    const openDraftRoom = useCallback(async () => {
        if (!currentLeague?.id || draftLoading) {
            router.push('/league')
            return
        }
        setDraftLoading(true)
        try {
            const draft = await getJoinableDraft(currentLeague.id, {
                includeCompletedRookie: true,
            })
            if (!draft) {
                router.push('/league')
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
    const { openDraftRoom, draftLoading } = useDraftRoomLauncher()

    return (
        <View style={styles.sidebar}>
            <ScrollView style={styles.sidebarScroll} contentContainerStyle={styles.sidebarScrollContent} showsVerticalScrollIndicator={false}>
                <View style={styles.brandRow}>
                    <BrandMark />
                    <View>
                        <Text style={styles.brandTitle}>Pancake</Text>
                        <Text style={styles.brandSubtitle}>Dynasty Hoops</Text>
                    </View>
                </View>

                <LeagueSwitcher />

                <View style={styles.navGroup}>
                    {PRIMARY_NAV.map((item) => (
                        <SidebarNavButton
                            key={item.href}
                            label={item.label}
                            icon={item.icon}
                            active={isRouteActive(pathname, item.href)}
                            href={item.href}
                        />
                    ))}
                </View>

                <View style={styles.navGroup}>
                    <SidebarNavButton
                        label="League"
                        icon="emoji-events"
                        active={pathname.startsWith('/league')}
                        href="/league"
                    />
                </View>

                <Text style={styles.navSectionLabel}>Season</Text>
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
                >
                    <View style={styles.userAvatar}>
                        <Text style={styles.userAvatarText}>{current?.team_name?.slice(0, 1).toUpperCase() ?? 'P'}</Text>
                    </View>
                    <View style={styles.flex1}>
                        <Text style={styles.userName} numberOfLines={1}>{current?.team_name ?? 'Profile'}</Text>
                        <Text style={styles.userMeta} numberOfLines={1}>Profile & settings</Text>
                    </View>
                    <MaterialIcons name="settings" size={17} color="rgba(232, 210, 184, 0.62)" />
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

    return (
        <View style={styles.mobileBottomNav}>
            {MOBILE_NAV.map((item) => {
                const active = isRouteActive(pathname, item.href)
                return (
                    <Link key={item.href} href={item.href} asChild>
                        <Pressable
                            style={({ pressed }: PressableState) => [styles.bottomNavItem, pressed && styles.pressed]}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                        >
                            <MaterialIcons name={item.icon} size={22} color={active ? colors.primary : colors.textMuted} />
                            <Text style={[styles.bottomNavText, active && styles.bottomNavTextActive]}>{item.label}</Text>
                        </Pressable>
                    </Link>
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

    if (!visible) return null

    return (
        <Pressable style={styles.sheetScrim} onPress={onClose}>
            <View style={styles.sheet} onStartShouldSetResponder={() => true}>
                <View style={styles.sheetHeader}>
                    <Text style={styles.sheetTitle}>Menu</Text>
                    <Pressable onPress={onClose} style={styles.sheetClose}>
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
                    >
                        <MaterialIcons name={item.icon} size={21} color={colors.textSecondary} />
                        <Text style={styles.sheetItemText}>{item.label}</Text>
                        {item.loading ? (
                            <ActivityIndicator size="small" color={colors.primary} />
                        ) : (
                            <MaterialIcons name="chevron-right" size={20} color={colors.textPlaceholder} />
                        )}
                    </Pressable>
                ))}
            </View>
        </Pressable>
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
    const [menuOpen, setMenuOpen] = useState(false)

    // Keep the shell mounted for ALL web routes (stable element type) so toggling
    // chrome on auth state change never remounts the route tree. Auth/loading
    // routes render chrome-less.
    if (!chrome) return <>{children}</>

    return (
        <View style={[styles.root, compact ? styles.rootCompact : styles.rootDesktop]}>
            {compact ? <MobileTopBar onMenuPress={() => setMenuOpen(true)} /> : <WebSidebar />}
            <View style={[styles.content, compact && styles.contentCompact]}>{children}</View>
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
