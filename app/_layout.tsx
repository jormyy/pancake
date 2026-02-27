import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native'
import { Stack, router } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import 'react-native-reanimated'

import { useColorScheme } from '@/hooks/use-color-scheme'
import { useAuth } from '@/hooks/use-auth'

export const unstable_settings = {
  anchor: '(tabs)',
}

export default function RootLayout() {
  const colorScheme = useColorScheme()
  const { session, loading } = useAuth()

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
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(modals)" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  )
}
