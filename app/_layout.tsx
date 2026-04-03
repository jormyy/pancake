import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import 'react-native-reanimated'

import { useColorScheme } from '@/hooks/use-color-scheme'
import { useAuth } from '@/hooks/use-auth'
import { LeagueProvider } from '@/contexts/league-context'
import { usePushNotifications } from '@/hooks/use-push-notifications'

export const unstable_settings = {
    anchor: '(tabs)',
}

export default function RootLayout() {
    const colorScheme = useColorScheme()
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
    }, [session, loading, segments])

    return (
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
            <LeagueProvider>
                <Stack>
                    <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                    <Stack.Screen name="(auth)" options={{ headerShown: false }} />
                    <Stack.Screen name="(modals)" options={{ headerShown: false }} />
                    <Stack.Screen
                        name="modal"
                        options={{ presentation: 'modal', title: 'Modal' }}
                    />
                </Stack>
            </LeagueProvider>
            <StatusBar style="auto" />
        </ThemeProvider>
    )
}
