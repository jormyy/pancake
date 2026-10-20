import { DefaultTheme, ThemeProvider } from '@react-navigation/native'
import { useFonts } from 'expo-font'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useState } from 'react'
import { Platform, View } from 'react-native'

import { colors } from '@/constants/tokens'
import { criticalFonts } from '@/constants/fonts'
import { AuthProvider, useAuth } from '@/hooks/use-auth'
import { LeagueProvider } from '@/contexts/league-context'
import { useWebPushNotifications } from '@/hooks/use-web-push-notifications'
import { FeedbackProvider } from '@/components/ui'
import { WebAppShell } from '@/components/navigation/WebTabShell'
import { LeagueAccessNotice } from '@/components/LeagueAccessNotice'
import { AuthHydrationFrame } from '@/components/auth/AuthHydrationFrame'

export const unstable_settings = {
    anchor: '(tabs)',
}

export default function RootLayout() {
    useFonts(criticalFonts)

    // Navigation chrome (stack headers, card backgrounds) uses the app's own
    // tokens. On web those are CSS variables, so headers follow the system
    // theme with the rest of the page. Native ships light only.
    //
    // The default theme's background is a neutral grey, and the static export
    // prerenders it into the root element — so a signed-out launch flashed grey
    // over the page before React painted the real screen background.
    const navTheme = {
        ...DefaultTheme,
        colors: {
            ...DefaultTheme.colors,
            background: colors.bgScreen,
            card: colors.bgCard,
            text: colors.textPrimary,
            border: colors.borderLight,
            primary: colors.primary,
        },
    }

    return (
        <ThemeProvider value={navTheme}>
            <FeedbackProvider>
                <AuthProvider>
                    <RootContent />
                </AuthProvider>
            </FeedbackProvider>
            <StatusBar style={Platform.OS === 'web' ? 'dark' : 'auto'} />
        </ThemeProvider>
    )
}

function RootContent() {
    const { session, loading } = useAuth()
    const [navigationMounted, setNavigationMounted] = useState(false)
    const router = useRouter()
    const segments = useSegments()
    useWebPushNotifications()
    const firstSegment = segments[0]
    const inAuthGroup = firstSegment === '(auth)' || firstSegment === 'sign-in' || firstSegment === 'sign-up'

    useEffect(() => { setNavigationMounted(true) }, [])

    useEffect(() => {
        if (loading || !navigationMounted) return
        if (session && inAuthGroup) {
            router.replace('/')
        } else if (!session && !inAuthGroup) {
            router.replace('/sign-in')
        }
    }, [session, loading, inAuthGroup, router, navigationMounted])

    // On web, mount the persistent app-shell (sidebar / mobile nav) at the root
    // so it wraps EVERY authenticated route — tabs, former modals, and player
    // detail alike. The chrome never disappears mid-flow. The shell stays mounted
    // for all web routes (chrome toggles off for auth/loading) so an auth-state
    // change never remounts the route tree. Native keeps its own bottom-tab
    // shell + platform stack modals.
    const webChrome = !!session && !inAuthGroup

    const stack = (
        <View style={{ flex: 1 }}>
            <LeagueAccessNotice />
            <Stack>
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="(auth)" options={{ headerShown: false }} />
                <Stack.Screen name="(modals)" options={{ headerShown: false }} />
                <Stack.Screen name="+not-found" options={{ headerShown: false }} />
                {/* Declare the dynamic player route so a cold deep-link (/player/<id>)
                    rehydrates a valid navigation state instead of crashing in
                    getRehydratedState. The screen sets its own header options. */}
                <Stack.Screen name="player/[id]" options={{ headerShown: false }} />
            </Stack>
        </View>
    )

    return (
        <LeagueProvider>
            {Platform.OS === 'web' ? (
                <WebAppShell chrome={webChrome}>
                    <AuthHydrationFrame route={inAuthGroup ? segments[segments.length - 1] : null}>
                        {stack}
                    </AuthHydrationFrame>
                </WebAppShell>
            ) : stack}
        </LeagueProvider>
    )
}
