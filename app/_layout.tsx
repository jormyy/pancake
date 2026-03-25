import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native'
import { Stack, router } from 'expo-router'
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
    usePushNotifications()

    useEffect(() => {
        if (loading) return
        if (session) {
            router.replace('/(tabs)')
        } else {
            router.replace('/(auth)/sign-in')
        }
    }, [session, loading])

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
