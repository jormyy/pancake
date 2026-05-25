import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { auth: { signOut: vi.fn() } } }))
vi.mock('@/lib/alert', () => ({ showAlert: vi.fn(), confirmAction: vi.fn() }))

function shouldRefreshLeague(
    newTeamName: string,
    currentTeamName: string | undefined,
    hasCurrent: boolean,
): boolean {
    return hasCurrent && newTeamName !== currentTeamName
}

function validateProfileSave(displayName: string): string | null {
    if (!displayName.trim()) return 'Display name cannot be empty.'
    return null
}

describe('shouldRefreshLeague', () => {
    it('returns true when hasCurrent and team name changed', () => {
        expect(shouldRefreshLeague('New Name', 'Old Name', true)).toBe(true)
    })

    it('returns false when team name did not change', () => {
        expect(shouldRefreshLeague('Same', 'Same', true)).toBe(false)
    })

    it('returns false when hasCurrent is false', () => {
        expect(shouldRefreshLeague('New Name', 'Old Name', false)).toBe(false)
    })

    it('returns false when hasCurrent is false and names differ', () => {
        expect(shouldRefreshLeague('A', 'B', false)).toBe(false)
    })
})

describe('validateProfileSave', () => {
    it('returns error string for empty display name', () => {
        expect(validateProfileSave('')).toBe('Display name cannot be empty.')
    })

    it('returns error string for whitespace-only display name', () => {
        expect(validateProfileSave('   ')).toBe('Display name cannot be empty.')
    })

    it('returns null for valid display name', () => {
        expect(validateProfileSave('Jeremy')).toBeNull()
    })

    it('returns null for display name with surrounding spaces', () => {
        expect(validateProfileSave('  Jeremy  ')).toBeNull()
    })
})

describe('sign-out error handling', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('calls showAlert when signOut throws', async () => {
        const { showAlert } = await import('@/lib/alert')
        const { supabase } = await import('@/lib/supabase')

        vi.mocked(supabase.auth.signOut)
            .mockRejectedValueOnce(new Error('network error'))
            .mockResolvedValueOnce({ error: null })

        const { signOut } = await import('@/lib/auth')

        async function handleSignOutOnError() {
            try {
                await signOut()
            } catch (e) {
                console.error(e)
                showAlert('Error', 'Sign out failed. Please try again.')
            }
        }

        await handleSignOutOnError()

        expect(showAlert).toHaveBeenCalledWith('Error', 'Sign out failed. Please try again.')
    })
})
