import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { ComponentProps, useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, Text, useWindowDimensions, View } from 'react-native'
import { Link, Tabs, useGlobalSearchParams, usePathname, useRouter } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { getActiveDraft } from '@/lib/draft'
import { colors } from '@/constants/tokens'
import { styles } from './webTabShellStyles'

type IconName = ComponentProps<typeof MaterialIcons>['name']
type LeagueTab = 'standings' | 'activity' | 'waivers' | 'picks'
type RouteHref = '/' | '/players' | '/roster' | '/trades' | '/league' | '/profile'

const PRIMARY_NAV: { label: string; href: RouteHref; icon: IconName }[] = [
    { label: 'Matchup', href: '/', icon: 'home' },
    { label: 'Players', href: '/players', icon: 'groups' },
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

type PressableState = { hovered?: boolean; pressed?: boolean }

function isRouteActive(pathname: string, href: RouteHref) {
    if (href === '/') return pathname === '/' || pathname === '' || pathname === '/index' || pathname === '/(tabs)' || pathname === '/(tabs)/index'
    return pathname.startsWith(href)
}

function injectThemeVariables() {
    if (typeof document === 'undefined' || document.getElementById('pancake-web-theme-vars')) return

    const style = document.createElement('style')
    style.id = 'pancake-web-theme-vars'
    style.textContent = `
        :root,
        :root[data-pancake-theme="light"] {
            --pancake-text-primary: #2C1A0E;
            --pancake-text-secondary: #6B4535;
            --pancake-text-muted: #9B7060;
            --pancake-text-placeholder: #B8917F;
            --pancake-text-disabled: #CCAA99;
            --pancake-bg-screen: #FDF8EE;
            --pancake-bg-card: #FFFDF8;
            --pancake-bg-muted: #F4E8D2;
            --pancake-bg-subtle: #FAF2E2;
            --pancake-bg-input: #FFFDF8;
            --pancake-separator: #E8D8BE;
            --pancake-border: #D9C4A5;
            --pancake-border-light: #E8D8BE;
            --pancake-primary: #C9660F;
            --pancake-primary-light: #FEF6E4;
            --pancake-primary-border: #FAD490;
            --pancake-primary-dark: #A05212;
            --pancake-danger: #EF4444;
            --pancake-danger-light: #FEE2E2;
            --pancake-danger-dark: #991B1B;
            --pancake-success: #10B981;
            --pancake-success-light: #D1FAE5;
            --pancake-success-dark: #065F46;
            --pancake-warning: #F59E0B;
            --pancake-warning-light: #FEF3C7;
            --pancake-warning-dark: #D97706;
            --pancake-info: #8B5CF6;
            --pancake-info-light: #EDE9FE;
            --pancake-accent: #3B82F6;
        }
        :root[data-pancake-theme="dark"] {
            --pancake-text-primary: #F5EBDA;
            --pancake-text-secondary: #CDB89D;
            --pancake-text-muted: #9C8268;
            --pancake-text-placeholder: #7A6147;
            --pancake-text-disabled: #5F4935;
            --pancake-bg-screen: #140D07;
            --pancake-bg-card: #211710;
            --pancake-bg-muted: #2B1F15;
            --pancake-bg-subtle: #19110A;
            --pancake-bg-input: #19110A;
            --pancake-separator: #382819;
            --pancake-border: #463320;
            --pancake-border-light: #382819;
            --pancake-primary: #E0852C;
            --pancake-primary-light: #2E2012;
            --pancake-primary-border: #5A3D1C;
            --pancake-primary-dark: #F2B765;
            --pancake-danger: #F0584A;
            --pancake-danger-light: #361712;
            --pancake-danger-dark: #FFB7AF;
            --pancake-success: #2DBE73;
            --pancake-success-light: #14301F;
            --pancake-success-dark: #95E6B8;
            --pancake-warning: #E8B53A;
            --pancake-warning-light: #302410;
            --pancake-warning-dark: #F5D47A;
            --pancake-info: #7C8BE8;
            --pancake-info-light: #1C2246;
            --pancake-accent: #6EA8FF;
        }
        :root[data-pancake-theme="dark"] body { background: #140D07; }
    `
    document.head.appendChild(style)
}

function usePancakeWebTheme() {
    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        if (typeof window === 'undefined') return 'light'
        const stored = window.localStorage.getItem('pancake-web-theme')
        if (stored === 'light' || stored === 'dark') return stored
        return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    })

    useEffect(() => {
        injectThemeVariables()
    }, [])

    useEffect(() => {
        if (typeof document === 'undefined') return
        document.documentElement.setAttribute('data-pancake-theme', theme)
        window.localStorage.setItem('pancake-web-theme', theme)
    }, [theme])

    return { theme, setTheme }
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

function LeagueSwitcher() {
    const { memberships, current, setCurrent } = useLeagueContext()
    const [open, setOpen] = useState(false)

    if (!current) {
        return (
            <View style={styles.leagueSwitch}>
                <View style={styles.leagueCrest}><Text style={styles.leagueCrestText}>P</Text></View>
                <View style={styles.flex1}>
                    <Text style={styles.leagueName} numberOfLines={1}>No league</Text>
                    <Text style={styles.leagueMeta} numberOfLines={1}>Create or join from League</Text>
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
                    hovered && styles.leagueSwitchHover,
                    pressed && styles.pressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Switch league"
            >
                <View style={styles.leagueCrest}>
                    <Text style={styles.leagueCrestText}>{(current.team_name ?? 'Team').slice(0, 1).toUpperCase()}</Text>
                </View>
                <View style={styles.flex1}>
                    <Text style={styles.leagueName} numberOfLines={1}>{current.leagues?.name ?? 'Pancake League'}</Text>
                    <Text style={styles.leagueMeta} numberOfLines={1}>{current.team_name ?? 'Team'}</Text>
                </View>
                <MaterialIcons name={open ? 'expand-less' : 'expand-more'} size={18} color="rgba(255, 246, 232, 0.7)" />
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
    const content = (
        <>
            {loading ? <ActivityIndicator size="small" color="rgba(255, 246, 232, 0.82)" /> : <NavIcon name={icon} active={active} />}
            <Text style={[styles.sideNavText, active && styles.sideNavTextActive]} numberOfLines={1}>{label}</Text>
        </>
    )

    if (href && !disabled && !loading) {
        return (
            <Link href={href} asChild>
                <Pressable
                    style={({ hovered, pressed }: PressableState) => [
                        styles.sideNavItem,
                        active && styles.sideNavItemActive,
                        hovered && !active && styles.sideNavItemHover,
                        pressed && styles.pressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityState={{ selected: active }}
                >
                    {content}
                </Pressable>
            </Link>
        )
    }

    return (
        <Pressable
            onPress={onPress}
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
            {content}
        </Pressable>
    )
}

function ThemeToggle({ theme, setTheme }: ReturnType<typeof usePancakeWebTheme>) {
    return (
        <View style={styles.themeToggle}>
            <View style={[styles.themeKnob, theme === 'dark' && styles.themeKnobDark]} />
            {(['light', 'dark'] as const).map((option) => {
                const active = theme === option
                return (
                    <Pressable
                        key={option}
                        onPress={() => setTheme(option)}
                        style={styles.themeOption}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                    >
                        <MaterialIcons name={option === 'light' ? 'light-mode' : 'dark-mode'} size={15} color={active ? colors.textWhite : 'rgba(232, 210, 184, 0.68)'} />
                        <Text style={[styles.themeOptionText, active && styles.themeOptionTextActive]}>
                            {option === 'light' ? 'Light' : 'Dark'}
                        </Text>
                    </Pressable>
                )
            })}
        </View>
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
            const draft = await getActiveDraft(currentLeague.id)
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

function WebSidebar({ theme, setTheme }: ReturnType<typeof usePancakeWebTheme>) {
    const pathname = usePathname()
    const router = useRouter()
    const params = useGlobalSearchParams<{ tab?: string }>()
    const { current, isCommissioner } = useLeagueContext()
    const { openDraftRoom, draftLoading } = useDraftRoomLauncher()
    const activeLeagueTab = params.tab === 'activity' || params.tab === 'waivers' || params.tab === 'picks'
        ? params.tab
        : 'standings'

    return (
        <View style={styles.sidebar}>
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

            <Text style={styles.navSectionLabel}>League</Text>
            <View style={styles.navGroup}>
                {LEAGUE_NAV.map((item) => (
                    <SidebarNavButton
                        key={item.tab}
                        label={item.label}
                        icon={item.icon}
                        active={pathname.startsWith('/league') && activeLeagueTab === item.tab}
                        href={`/league?tab=${item.tab}`}
                    />
                ))}
            </View>

            <Text style={styles.navSectionLabel}>Season</Text>
            <View style={styles.navGroup}>
                <SidebarNavButton label="Draft Room" icon="flash-on" onPress={openDraftRoom} loading={draftLoading} />
                <SidebarNavButton label="Playoffs" icon="account-tree" onPress={() => router.push('/(modals)/bracket')} />
                {isCommissioner ? (
                    <SidebarNavButton label="Commissioner" icon="admin-panel-settings" onPress={() => router.push('/(modals)/commissioner-settings')} />
                ) : null}
            </View>

            <View style={styles.sidebarFooter}>
                <ThemeToggle theme={theme} setTheme={setTheme} />
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
                <LeagueSwitcher />
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

function MobileMenuSheet({
    visible,
    onClose,
    theme,
    setTheme,
}: { visible: boolean; onClose: () => void } & ReturnType<typeof usePancakeWebTheme>) {
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
                <View style={styles.sheetThemeWrap}>
                    <ThemeToggle theme={theme} setTheme={setTheme} />
                </View>
            </View>
        </Pressable>
    )
}

function WebShell() {
    const { width } = useWindowDimensions()
    const compact = width < 780
    const themeState = usePancakeWebTheme()
    const [menuOpen, setMenuOpen] = useState(false)

    return (
        <View style={[styles.root, compact ? styles.rootCompact : styles.rootDesktop]}>
            {compact ? <MobileTopBar onMenuPress={() => setMenuOpen(true)} /> : <WebSidebar {...themeState} />}
            <View style={[styles.content, compact && styles.contentCompact]}>
                <Tabs tabBar={() => null} screenOptions={{ headerShown: false }}>
                    <Tabs.Screen name="index" />
                    <Tabs.Screen name="players" />
                    <Tabs.Screen name="roster" />
                    <Tabs.Screen name="trades" />
                    <Tabs.Screen name="league" />
                    <Tabs.Screen name="profile" />
                </Tabs>
            </View>
            {compact ? (
                <>
                    <MobileBottomNav />
                    <MobileMenuSheet visible={menuOpen} onClose={() => setMenuOpen(false)} {...themeState} />
                </>
            ) : null}
        </View>
    )
}

export default function WebTabLayout() {
    return <WebShell />
}
