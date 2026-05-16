import { supabase } from '@/lib/supabase'
import type { Profile } from '@/types/database'

export async function signUp(
    email: string,
    password: string,
    username: string,
    displayName: string,
) {
    // Pre-check username availability BEFORE creating the auth user.
    // Rolling back auth.users from the client is impossible (admin-only), so we
    // try to catch the most common profile-insert failure (duplicate username)
    // ahead of time. There's still a TOCTOU race, but it eliminates the common case.
    const { data: existing, error: lookupError } = await supabase
        .from('profiles')
        .select('id')
        .eq('username', username)
        .maybeSingle()

    if (lookupError) throw lookupError
    if (existing) throw new Error('That username is taken. Please choose another.')

    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) throw error

    const { error: profileError } = await supabase.from('profiles').insert({
        id: data.user!.id,
        username,
        display_name: displayName,
    })

    if (profileError) {
        // Profile insert failed AFTER auth.users was created (RLS denial, race
        // on username, network hiccup). We can't delete auth.users from the
        // client, but we CAN sign the user back out so the client is in a clean
        // state and the UI doesn't get stuck on a profile-less session. The
        // orphaned auth.users row will be cleaned up server-side (or the user
        // can retry with a different email after confirmation timeout).
        try {
            await supabase.auth.signOut()
        } catch {
            // best-effort; surface the original profile error regardless
        }
        throw new Error(
            `Could not create your profile (${profileError.message}). Please try again with a different username or email.`,
        )
    }

    return data
}

export async function signIn(email: string, password: string) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data
}

export async function signOut() {
    const { error } = await supabase.auth.signOut()
    if (error) {
        // Server sign-out failed (network error, unexpected server error, etc.).
        // Fall back to local-only sign-out so the user can always sign out on their device.
        await supabase.auth.signOut({ scope: 'local' })
    }
}

export async function getProfile(userId: string) {
    // Explicit column list — push_token is column-revoked from authenticated
    // (iter 27 Slice C); `select('*')` would 42501 in production.
    const { data, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, created_at, updated_at')
        .eq('id', userId)
        .single<Profile>()
    if (error) throw error
    return data
}

export async function updateProfile(userId: string, updates: { display_name?: string }) {
    const { error } = await supabase
        .from('profiles')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', userId)
    if (error) throw error
}
