import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { Platform } from 'react-native'
import 'react-native-reanimated'

import { useColorScheme } from '@/hooks/use-color-scheme'
import { AuthProvider, useAuth } from '@/hooks/use-auth'
import { LeagueProvider } from '@/contexts/league-context'
import { usePushNotifications } from '@/hooks/use-push-notifications'

export const unstable_settings = {
    anchor: '(tabs)',
}

export default function RootLayout() {
    const colorScheme = useColorScheme()

    // Web ships light-only (locked decision): never let react-navigation chrome
    // (modal/stack headers) follow the OS dark preference. Native keeps dark.
    const navTheme =
        Platform.OS !== 'web' && colorScheme === 'dark' ? DarkTheme : DefaultTheme

    return (
        <ThemeProvider value={navTheme}>
            <AuthProvider>
                <RootContent />
            </AuthProvider>
            <StatusBar style={Platform.OS === 'web' ? 'dark' : 'auto'} />
        </ThemeProvider>
    )
}

function RootContent() {
    const { session, loading } = useAuth()
    const router = useRouter()
    const segments = useSegments()
    usePushNotifications()

    useEffect(() => {
        if (loading) return
        const inAuthGroup = segments[0] === '(auth)'
        if (session && inAuthGroup) {
            router.replace('/(tabs)')
        } else if (!session && !inAuthGroup) {
            router.replace('/(auth)/sign-in')
        }
    }, [session, loading, segments, router])

    return (
        <LeagueProvider>
            <Stack>
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen name="(auth)" options={{ headerShown: false }} />
                <Stack.Screen name="(modals)" options={{ headerShown: false }} />
            </Stack>
        </LeagueProvider>
    )
}
