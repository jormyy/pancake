import { supabase } from '@/lib/supabase'
import type { Profile } from '@/types/database'
import { unregisterCurrentDevicePushToken } from '@/lib/push-token'
import { clearPersistentCaches } from '@/lib/persistent-cache'

export async function signUp(
    email: string,
    password: string,
    username: string,
    displayName: string,
) {
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
    try {
        await unregisterCurrentDevicePushToken()
    } catch (error) {
        console.warn('Push-token revocation was queued for retry.', error)
    }

    try {
        const { error } = await supabase.auth.signOut()
        if (!error) return
    } catch (error) {
        console.warn('Server sign-out failed; clearing the local session.', error)
    } finally {
        clearPersistentCaches()
    }

    const { error: localError } = await supabase.auth.signOut({ scope: 'local' })
    if (localError) throw localError
}

export async function changePassword(currentPassword: string, newPassword: string) {
    const { data: userData, error: userErr } = await supabase.auth.getUser()
    const email = userData.user?.email
    if (userErr || !email) throw new Error('You must be signed in to change your password.')

    // supabase.auth.updateUser({ password }) does NOT require the current
    // password, so verify identity first by re-authenticating. This prevents a
    // walk-up attacker (or a hijacked session) from silently changing it.
    const { error: reauthError } = await supabase.auth.signInWithPassword({ email, password: currentPassword })
    if (reauthError) throw new Error('Your current password is incorrect.')

    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) throw error
}

export async function getProfile(userId: string) {
    // Explicit column list — push_token is column-revoked from authenticated
    // (iter 27 Slice C); `select('*')` would 42501 in production.
    const { data, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, created_at, updated_at')
        .eq('id', userId)
        .single<Profile>()
    if (error) throw error
    return data
}

export async function updateProfile(userId: string, updates: { display_name?: string; avatar_url?: string }) {
    const { error } = await supabase
        .from('profiles')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', userId)
    if (error) throw error
}

export async function uploadAvatar(userId: string, imageUri: string): Promise<string> {
    const response = await fetch(imageUri)
    const blob = await response.blob()

    // Fixed path per user so upsert replaces the previous avatar
    const ext = imageUri.split('.').pop()?.split('?')[0]?.toLowerCase() ?? 'jpg'
    const path = `${userId}/avatar.${ext}`

    const { error } = await supabase.storage
        .from('avatars')
        .upload(path, blob, { upsert: true, contentType: blob.type || 'image/jpeg' })
    if (error) throw error

    const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path)

    // Append cache-buster so the new image shows immediately
    const bustUrl = `${publicUrl}?t=${Date.now()}`
    await updateProfile(userId, { avatar_url: bustUrl })
    return bustUrl
}
