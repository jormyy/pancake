import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native'
import { Outfit_500Medium, Outfit_600SemiBold, Outfit_700Bold, useFonts } from '@expo-google-fonts/outfit'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { Platform } from 'react-native'
import 'react-native-reanimated'

import { useColorScheme } from '@/hooks/use-color-scheme'
import { AuthProvider, useAuth } from '@/hooks/use-auth'
import { LeagueProvider } from '@/contexts/league-context'
import { usePushNotifications } from '@/hooks/use-push-notifications'
import { FeedbackProvider } from '@/components/ui'
import { WebAppShell } from '@/components/navigation/WebTabShell'

export const unstable_settings = {
    anchor: '(tabs)',
}

export default function RootLayout() {
    const colorScheme = useColorScheme()

    // Display face (headlines + big numerals). Deliberately NOT gating render on
    // the loaded flag: text paints immediately with the fallback stack in
    // constants/tokens.ts fontFamily and upgrades in place once the font arrives.
    useFonts({ Outfit_500Medium, Outfit_600SemiBold, Outfit_700Bold })

    // Web ships light-only (locked decision): never let react-navigation chrome
    // (modal/stack headers) follow the OS dark preference. Native keeps dark.
    const navTheme =
        Platform.OS !== 'web' && colorScheme === 'dark' ? DarkTheme : DefaultTheme

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
    const router = useRouter()
    const segments = useSegments()
    usePushNotifications()
    const firstSegment = segments[0]
    const inAuthGroup = firstSegment === '(auth)' || firstSegment === 'sign-in' || firstSegment === 'sign-up'

    useEffect(() => {
        if (loading) return
        if (session && inAuthGroup) {
            router.replace('/')
        } else if (!session && !inAuthGroup) {
            router.replace('/(auth)/sign-in')
        }
    }, [session, loading, inAuthGroup, router])

    // On web, mount the persistent app-shell (sidebar / mobile nav) at the root
    // so it wraps EVERY authenticated route — tabs, former modals, and player
    // detail alike. The chrome never disappears mid-flow. The shell stays mounted
    // for all web routes (chrome toggles off for auth/loading) so an auth-state
    // change never remounts the route tree. Native keeps its own bottom-tab
    // shell + platform stack modals.
    const webChrome = !!session && !inAuthGroup

    const stack = (
        <Stack>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="(auth)" options={{ headerShown: false }} />
            <Stack.Screen name="(modals)" options={{ headerShown: false }} />
            {/* Declare the dynamic player route so a cold deep-link (/player/<id>)
                rehydrates a valid navigation state instead of crashing in
                getRehydratedState. The screen sets its own header options. */}
            <Stack.Screen name="player/[id]" />
        </Stack>
    )

    return (
        <LeagueProvider>
            {Platform.OS === 'web' ? <WebAppShell chrome={webChrome}>{stack}</WebAppShell> : stack}
        </LeagueProvider>
    )
}
