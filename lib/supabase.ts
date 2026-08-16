import 'react-native-url-polyfill/auto'
import { createClient, type Session } from '@supabase/supabase-js'
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
const supabasePublicKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
const SUPABASE_URL_OVERRIDE_KEY = 'PANCAKE_SUPABASE_URL'
const SUPABASE_PUBLIC_KEY_OVERRIDE_KEY = 'PANCAKE_SUPABASE_PUBLIC_KEY'

const overrideParamName = (key: string): string | null => {
    if (key === SUPABASE_URL_OVERRIDE_KEY) return 'pancake_supabase_url'
    if (key === SUPABASE_PUBLIC_KEY_OVERRIDE_KEY) return 'pancake_supabase_public_key'
    return null
}

function runtimeSupabaseOverride(key: string): string | null {
    if (process.env.NODE_ENV === 'production') return null
    if (Platform.OS !== 'web' || typeof window === 'undefined') return null

    try {
        const paramName = overrideParamName(key)
        const paramValue = paramName ? new URLSearchParams(window.location.search).get(paramName) : null
        if (paramValue) {
            window.localStorage.setItem(key, paramValue)
            return paramValue
        }
        return window.localStorage.getItem(key)
    } catch {
        return null
    }
}

// Synchronously read the session supabase-js persisted to localStorage so the
// first render already knows who is signed in. Without this, every screen
// waits for the async getSession() round-trip on each refresh, which defeats
// the persistent per-user caches (their keys need user.id). The token may be
// expired — that's fine: it's only used to seed UI state; supabase-js still
// validates/refreshes it through the normal async path.
export function readStoredSessionSync(): Session | null {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return null
    try {
        const storage = window.localStorage
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index)
            if (!key || !key.startsWith('sb-') || !key.endsWith('-auth-token')) continue
            const parsed = JSON.parse(storage.getItem(key) ?? '') as Session
            if (parsed && typeof parsed === 'object' && parsed.access_token && parsed.user?.id) return parsed
        }
    } catch {
        // Private mode / corrupt entry — fall back to the async path.
    }
    return null
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
