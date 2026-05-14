import 'react-native-url-polyfill/auto'
import { createClient } from '@supabase/supabase-js'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { Database } from '@/types/database'

// SecureStore is native-only — fall back to undefined (default storage) on web/SSR
const ExpoSecureStoreAdapter =
    Platform.OS === 'web'
        ? undefined
        : {
              getItem: (key: string) => SecureStore.getItemAsync(key),
              setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
              removeItem: (key: string) => SecureStore.deleteItemAsync(key),
          }

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!
const supabasePublicKey =
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
const SUPABASE_URL_OVERRIDE_KEY = 'PANCAKE_SUPABASE_URL'
const SUPABASE_PUBLIC_KEY_OVERRIDE_KEY = 'PANCAKE_SUPABASE_ANON_KEY'

function runtimeSupabaseOverride(key: string): string | null {
    if (process.env.NODE_ENV === 'production') return null
    if (Platform.OS !== 'web' || typeof window === 'undefined') return null

    try {
        return window.localStorage.getItem(key)
    } catch {
        return null
    }
}

export const supabase = createClient<Database>(
    runtimeSupabaseOverride(SUPABASE_URL_OVERRIDE_KEY) ?? supabaseUrl,
    runtimeSupabaseOverride(SUPABASE_PUBLIC_KEY_OVERRIDE_KEY) ?? supabasePublicKey,
    {
        auth: {
            storage: ExpoSecureStoreAdapter,
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: false,
        },
    },
)
