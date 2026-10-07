import 'react-native-url-polyfill/auto'
import { createClient } from '@supabase/supabase-js'
import { Platform } from 'react-native'
import { Database } from '@/types/database'
import { fenceDataRequests } from '@/lib/session-fetch'
import { authStorageKey, inspectSession, readStoredAuth, type StoredAuthState } from '@/lib/auth-session'
import { createAuthStorage } from '@/lib/auth-storage'

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

const resolvedSupabaseUrl = runtimeSupabaseOverride(SUPABASE_URL_OVERRIDE_KEY) ?? supabaseUrl
export const supabaseAuthStorageKey = authStorageKey(resolvedSupabaseUrl)
const authStorage = createAuthStorage(() => typeof window === 'undefined' ? null : window.localStorage)

export function inspectAuthSession(value: unknown): StoredAuthState {
    return inspectSession(value, resolvedSupabaseUrl)
}

export function readStoredAuthState(): StoredAuthState {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return { session: null, status: 'missing' }
    const stored = authStorage.read(supabaseAuthStorageKey)
    return stored.available
        ? readStoredAuth({ getItem: () => stored.value }, resolvedSupabaseUrl)
        : { session: null, status: 'unavailable' }
}

export const supabase = createClient<Database>(
    resolvedSupabaseUrl,
    runtimeSupabaseOverride(SUPABASE_PUBLIC_KEY_OVERRIDE_KEY) ?? supabasePublicKey,
    {
        auth: {
            storageKey: supabaseAuthStorageKey,
            storage: authStorage,
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: false,
        },
        global: { fetch: fenceDataRequests((input, init) => fetch(input, init)) },
    },
)
