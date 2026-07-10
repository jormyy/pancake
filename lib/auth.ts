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
    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { username, display_name: displayName } },
    })
    if (error) throw error
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

type AvatarAsset = {
    uri: string
    mimeType?: string | null
    fileSize?: number | null
}

const AVATAR_TYPES = new Map([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
])
const MAX_AVATAR_BYTES = 5 * 1024 * 1024

export async function uploadAvatar(userId: string, asset: AvatarAsset): Promise<string> {
    const response = await fetch(asset.uri)
    if (!response.ok) throw new Error('Could not read the selected image.')
    const blob = await response.blob()
    const contentType = (blob.type || asset.mimeType || '').toLowerCase()
    const extension = AVATAR_TYPES.get(contentType)
    if (!extension) throw new Error('Choose a JPEG, PNG, or WebP image.')
    const byteLength = blob.size || asset.fileSize || 0
    if (byteLength > MAX_AVATAR_BYTES) throw new Error('Choose an image smaller than 5 MB.')

    const path = `${userId}/avatar.${extension}`

    const { error } = await supabase.storage
        .from('avatars')
        .upload(path, blob, { upsert: true, contentType })
    if (error) throw error

    const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path)

    // Append cache-buster so the new image shows immediately
    const bustUrl = `${publicUrl}?t=${Date.now()}`
    await updateProfile(userId, { avatar_url: bustUrl })
    return bustUrl
}
