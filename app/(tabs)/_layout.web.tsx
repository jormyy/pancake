import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Tabs, usePathname, useRouter } from 'expo-router'
import { colors, palette } from '@/constants/tokens'

const NAVBAR_HEIGHT = 48

const NAV_ITEMS = [
    { label: 'Home',    href: '/' },
    { label: 'Players', href: '/players' },
    { label: 'Roster',  href: '/roster' },
    { label: 'Trades',  href: '/trades' },
    { label: 'League',  href: '/league' },
] as const

function isRouteActive(pathname: string, href: string) {
    if (href === '/') return pathname === '/' || pathname === '' || pathname === '/(tabs)'
    return pathname.startsWith(href)
}

function WebNavBar() {
    const pathname = usePathname()
    const router = useRouter()

    return (
        <View style={styles.navbar}>
            {/* Logo */}
            <Text style={styles.logo}>Pancake</Text>

            {/* Center nav items */}
            <View style={styles.navItems}>
                {NAV_ITEMS.map((item) => {
                    const active = isRouteActive(pathname, item.href)
                    return (
                        <Pressable
                            key={item.href}
                            onPress={() => router.push(item.href)}
                            style={({ hovered }: any) => [
                                styles.navItem,
                                hovered && styles.navItemHovered,
                            ]}
                        >
                            <Text style={[styles.navLabel, active && styles.navLabelActive]}>
                                {item.label}
                            </Text>
                        </Pressable>
                    )
                })}
            </View>

            {/* Profile on right */}
            <Pressable
                onPress={() => router.push('/profile')}
                style={({ hovered }: any) => [
                    styles.profileButton,
                    hovered && styles.navItemHovered,
                ]}
            >
                <Text
                    style={[
                        styles.navLabel,
                        isRouteActive(pathname, '/profile') && styles.navLabelActive,
                    ]}
                >
                    Profile
                </Text>
            </Pressable>
        </View>
    )
}

export default function WebTabLayout() {
    return (
        <View style={styles.root}>
            <WebNavBar />
            <View style={styles.content}>
                <Tabs
                    tabBar={() => null}
                    screenOptions={{ headerShown: false }}
                >
                    <Tabs.Screen name="index" />
                    <Tabs.Screen name="players" />
                    <Tabs.Screen name="roster" />
                    <Tabs.Screen name="trades" />
                    <Tabs.Screen name="league" />
                    <Tabs.Screen name="profile" />
                </Tabs>
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
    root: {
        flex: 1,
        flexDirection: 'column',
    },
    navbar: {
        height: NAVBAR_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 24,
        backgroundColor: 'rgba(253, 248, 238, 0.85)' as any,
        // @ts-ignore — web-only CSS properties
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        borderBottomWidth: 1,
        borderBottomColor: palette.cream300,
        position: 'sticky' as any,
        top: 0,
        zIndex: 1000,
    },
    logo: {
        fontSize: 17,
        fontWeight: '600',
        color: colors.primary,
        letterSpacing: -0.3,
        minWidth: 100,
    },
    navItems: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 4,
    },
    navItem: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 6,
    },
    navItemHovered: {
        backgroundColor: palette.cream200,
    },
    navLabel: {
        fontSize: 13,
        fontWeight: '400',
        color: colors.textSecondary,
        letterSpacing: -0.1,
    },
    navLabelActive: {
        color: colors.primary,
        fontWeight: '500',
    },
    profileButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 6,
        minWidth: 100,
        alignItems: 'flex-end',
    },
    content: {
        flex: 1,
    },
})
