import { Stack } from 'expo-router'

export default function ModalsLayout() {
  return (
    <Stack>
      <Stack.Screen name="create-league" options={{ title: 'Create League', presentation: 'modal' }} />
      <Stack.Screen name="join-league" options={{ title: 'Join League', presentation: 'modal' }} />
      <Stack.Screen name="commissioner-settings" options={{ title: 'League Settings', presentation: 'modal' }} />
    </Stack>
  )
}
