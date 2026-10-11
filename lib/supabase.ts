import 'react-native-url-polyfill/auto'
import { createClient } from '@supabase/supabase-js'
import { Platform } from 'react-native'
import { Database } from '@/types/database'
import { fenceDataRequests } from '@/lib/session-fetch'
import { authStorageKey, inspectSession, readStoredAuth, type StoredAuthState } from '@/lib/auth-session'
import { createAuthStorage } from '@/lib/auth-storage'
import { createAuthInvalidation } from '@/lib/auth-invalidation'
import { setSessionOwner } from '@/lib/session-cache-registry'
import { authNavigatorLock } from '@/lib/auth-lock'

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
const resolvedSupabasePublicKey = runtimeSupabaseOverride(SUPABASE_PUBLIC_KEY_OVERRIDE_KEY) ?? supabasePublicKey
export const supabaseAuthStorageKey = authStorageKey(resolvedSupabaseUrl)
export const localAuthChangeEvent = 'pancake-local-auth-change'
const authStorage = createAuthInvalidation(
    createAuthStorage(() => typeof window === 'undefined' ? null : window.localStorage),
    createAuthStorage(() => typeof window === 'undefined' ? null : window.sessionStorage),
    supabaseAuthStorageKey,
    () => {
        if (typeof window !== 'undefined') window.dispatchEvent(new Event(localAuthChangeEvent))
    },
)
const logoutChannel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(`${supabaseAuthStorageKey}-local-logout`) : null
if (logoutChannel) logoutChannel.onmessage = (event) => {
    const value = event.data as { id?: unknown; signedOut?: unknown; generation?: unknown }
    if (typeof value?.id === 'string' && value.signedOut === true && Number.isSafeInteger(value.generation)) {
        authStorage.receive({ id: value.id, signedOut: true, generation: value.generation as number })
    }
}

export async function invalidateLocalAuthSession(): Promise<void> {
    const clear = async () => {
        authStorage.invalidate()
        setSessionOwner(null)
        logoutChannel?.postMessage(authStorage.current())
    }
    if (typeof navigator !== 'undefined' && navigator.locks) {
        await authNavigatorLock(`lock:${supabaseAuthStorageKey}`, 10_000, clear)
    } else await clear()
}

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
    resolvedSupabasePublicKey,
    {
        auth: {
            storageKey: supabaseAuthStorageKey,
            storage: authStorage,
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: false,
            ...(typeof navigator !== 'undefined' && navigator.locks ? { lock: authNavigatorLock } : {}),
        },
        global: { fetch: authStorage.fetch(fenceDataRequests((input, init) => fetch(input, init))) },
    },
)

type SessionTokens = { access_token: string; refresh_token: string }

/** The saved session's tokens, even after the access token expired, so sign-out can still revoke it. */
export function readStoredSessionTokens(): SessionTokens | null {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return null
    const stored = authStorage.read(supabaseAuthStorageKey)
    if (!stored.available || !stored.value) return null
    try {
        const session = JSON.parse(stored.value) as Partial<SessionTokens>
        return typeof session.access_token === 'string' && typeof session.refresh_token === 'string' && session.refresh_token
            ? { access_token: session.access_token, refresh_token: session.refresh_token }
            : null
    } catch {
        return null
    }
}

/**
 * Revoke a session this device already signed out of. A separate in-memory client refreshes an
 * expired access token if needed and never writes the device's stored auth. `beforeRevoke` gets
 * a usable access token for server cleanup that needs the old identity.
 */
export async function revokeDetachedSession(
    tokens: SessionTokens,
    beforeRevoke: (accessToken: string) => Promise<void>,
): Promise<boolean> {
    const detached = createClient<Database>(resolvedSupabaseUrl, resolvedSupabasePublicKey, {
        auth: {
            storageKey: `${supabaseAuthStorageKey}-revoke`,
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
        },
    })
    const { data, error } = await detached.auth.setSession(tokens)
    if (error || !data.session) return false
    await beforeRevoke(data.session.access_token)
    const { error: signOutError } = await detached.auth.signOut()
    return !signOutError
}
