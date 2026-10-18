import { withPwaMutation } from '@/lib/shared/pwa-mutation'
import {
    supabase, captureLocalAuthSession, localAuthSessionMatches, invalidateLocalAuthSession, readStoredSessionTokens, revokeDetachedSession,
} from '@/lib/supabase'
import type { Profile } from '@/types/database'
import { completeWebPushLogin, detachWebPushFromAccount, prepareWebPushLogin } from '@/lib/web-push'
import { waitForAuthInitialization } from '@/lib/auth-lock'
import { sessionGeneration, sessionOwner } from '@/lib/session-cache-registry'

export async function signUp(
    email: string,
    password: string,
    username: string,
    displayName: string,
) {
    return withPwaMutation('signUp', async () => {
        const pushIntent = await prepareWebPushLogin()
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: { data: { username, display_name: displayName } },
        })
        if (error) throw error
        if (data.session) await completeWebPushLogin(pushIntent, data.session.user.id)
        return data
    })
}

export async function signIn(email: string, password: string) {
    return withPwaMutation('signIn', async () => {
        const pushIntent = await prepareWebPushLogin()
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        if (data.session) await completeWebPushLogin(pushIntent, data.session.user.id)
        return data
    })
}

export async function signOut() {
    return withPwaMutation('signOut', async () => {
        const owner = sessionOwner()
        const generation = sessionGeneration()
        const expected = captureLocalAuthSession()
        // The raw stored tokens survive an expired access token, so the server session can still be revoked.
        const tokens = readStoredSessionTokens()
        const stillCurrent = () => sessionOwner() === owner && sessionGeneration() === generation
            && (!expected.session || expected.session.user.id === owner) && localAuthSessionMatches(expected)
        if (!stillCurrent()) throw new Error('Your account changed. Please retry.')

        // This device drops the account before any network call: a slow or offline server must
        // not keep private screens visible. Only the captured account is cleared, never a newer one.
        if (!await invalidateLocalAuthSession(expected, stillCurrent)) throw new Error('Your account changed. Please retry.')
        const cleanupGeneration = sessionGeneration()
        const cleanupCurrent = () => sessionOwner() === null && sessionGeneration() === cleanupGeneration
        try {
            const { error: startupError } = await waitForAuthInitialization(supabase.auth.initialize())
            if (startupError) console.warn('Session startup failed during sign-out.', startupError)
            // No stored session remains, so this only clears the SDK and notifies auth and realtime listeners.
            await supabase.auth.signOut({ scope: 'local' })
        } catch (error) {
            console.warn('Local sign-out cleanup failed.', error)
        }

        // Notification cleanup acts for the captured account: with a usable session it removes the server
        // registration, otherwise it still stops delivery to this browser.
        let pushHandled = false
        const detachPush = async (accessToken: string | null) => {
            if (!owner || pushHandled) return
            pushHandled = true
            try {
                await detachWebPushFromAccount({ ownerId: owner, accessToken }, cleanupCurrent)
            } catch (error) {
                console.warn('Web push detach failed.', error)
            }
        }

        let serverSignOutConfirmed = !tokens
        if (tokens) {
            try {
                serverSignOutConfirmed = await revokeDetachedSession(tokens, detachPush)
                if (!serverSignOutConfirmed) console.warn('Server sign-out could not be confirmed.')
            } catch (error) {
                console.warn('Server sign-out could not be confirmed.', error)
            }
        }
        await detachPush(null)
        return { serverSignOutConfirmed }
    })
}

export async function changePassword(currentPassword: string, newPassword: string) {
    return withPwaMutation('changePassword', async () => {
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
    })
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
    return withPwaMutation('updateProfile', async () => {
        const { error } = await supabase
            .from('profiles')
            .update({ ...updates, updated_at: new Date().toISOString() })
            .eq('id', userId)
        if (error) throw error
    })
}

type AvatarAsset = {
    uri: string
    width: number
    height: number
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
    return withPwaMutation('uploadAvatar', async () => {
        // The web picker returns zero dimensions when the browser cannot decode the file.
        if (!Number.isFinite(asset.width) || asset.width <= 0
            || !Number.isFinite(asset.height) || asset.height <= 0) {
            throw new Error('Could not read the selected image. Choose another photo.')
        }
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
    })
}
