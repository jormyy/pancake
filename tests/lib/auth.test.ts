import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ supabase: { auth: {}, from: vi.fn() } }))

import { supabase } from '@/lib/supabase'
import { signUp, signIn, signOut, getProfile, updateProfile } from '@/lib/auth'

beforeEach(() => {
    vi.clearAllMocks()
})

describe('signUp', () => {
    it('creates a new account with valid email and password', async () => {
        vi.mocked(supabase.auth.signUp).mockResolvedValue({
            data: { user: { id: 'user-123' } },
            error: null,
        })
        vi.mocked(supabase.from).mockReturnValue({
            select: vi.fn().mockReturnValue({
                insert: vi.fn().mockResolvedValue({ error: null }),
            }),
        })

        const result = await signUp('test@example.com', 'ValidPass123!', 'testuser', 'Test User')

        expect(supabase.auth.signUp).toHaveBeenCalledWith('test@example.com', 'ValidPass123!')
        expect(supabase.from()).toHaveBeenCalledWith('profiles')
        expect(result).toEqual({ user: { id: 'user-123' } })
    })

    it('throws error when sign-up fails (auth error)', async () => {
        const authError = { message: 'Invalid email address' }
        vi.mocked(supabase.auth.signUp).mockResolvedValue({
            data: null,
            error: authError,
        })

        await expect(signUp('invalid@example.com', 'pass123!', 'user', 'User'))
            .rejects.toThrow('Invalid email address')
    })

    it('throws error when profile insert fails', async () => {
        const dbError = { code: '23505', message: 'Duplicate key' }
        vi.mocked(supabase.auth.signUp).mockResolvedValue({
            data: { user: { id: 'user-123' } },
            error: null,
        })
        vi.mocked(supabase.from).mockReturnValue({
            select: vi.fn().mockReturnValue({
                insert: vi.fn().mockResolvedValue({ error: dbError }),
            }),
        })

        await expect(signUp('test@example.com', 'pass123!', 'user', 'User'))
            .rejects.toThrow('Duplicate key')
    })

    it('throws error when profile insert fails with non-code error', async () => {
        vi.mocked(supabase.auth.signUp).mockResolvedValue({
            data: { user: { id: 'user-123' } },
            error: null,
        })
        vi.mocked(supabase.from).mockReturnValue({
            select: vi.fn().mockReturnValue({
                insert: vi.fn().mockResolvedValue({ error: { message: 'Database constraint violation' } }),
            }),
        })

        await expect(signUp('test@example.com', 'pass123!', 'user', 'User'))
            .rejects.toThrow('Database constraint violation')
    })

    it('creates account that already exists (email collision)', async () => {
        vi.mocked(supabase.auth.signUp).mockResolvedValue({
            data: { user: { id: 'existing-user', email: 'existing@example.com' } },
            error: null,
        })
        vi.mocked(supabase.from).mockReturnValue({
            select: vi.fn().mockReturnValue({
                insert: vi.fn().mockResolvedValue({ error: { code: '23505', message: 'Duplicate key' } }),
            }),
        })

        await expect(signUp('existing@example.com', 'pass123!', 'New User', 'New User'))
            .rejects.toThrow('Duplicate key')
    })
})

describe('signIn', () => {
    it('logs in successfully with valid credentials', async () => {
        vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({
            data: { user: { id: 'user-456', email: 'valid@example.com' }, session: { access_token: 'token-abc' } },
            error: null,
        })

        const result = await signIn('valid@example.com', 'CorrectPassword456!')

        expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith('valid@example.com', 'CorrectPassword456!')
        expect(result).toEqual({ user: { id: 'user-456', email: 'valid@example.com' }, session: { access_token: 'token-abc' } })
    })

    it('throws error with invalid password', async () => {
        vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({
            data: null,
            error: { message: 'Invalid login credentials' },
        })

        await expect(signIn('valid@example.com', 'WrongPassword'))
            .rejects.toThrow('Invalid login credentials')
    })

    it('throws error when auth fails completely', async () => {
        vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({
            data: null,
            error: { message: 'Auth service unavailable' },
        })

        await expect(signIn('valid@example.com', 'CorrectPassword456!'))
            .rejects.toThrow('Auth service unavailable')
    })

    it('throws error when server returns no data or error', async () => {
        vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({
            data: null,
            error: null,
        })

        await expect(signIn('valid@example.com', 'CorrectPassword456!'))
            .rejects.toThrow()
    })
})

describe('signOut', () => {
    it('calls supabase auth signOut and clears local session on success', async () => {
        vi.mocked(supabase.auth.signOut).mockResolvedValue({ error: null })

        const mockRemoveSession = vi.fn().mockResolvedValue(undefined)
        vi.mocked(supabase.auth as any)._removeSession = mockRemoveSession

        await signOut()

        expect(supabase.auth.signOut).toHaveBeenCalled()
        expect(mockRemoveSession).toHaveBeenCalled()
    })

    it('forces-clear local session when server signOut fails', async () => {
        vi.mocked(supabase.auth.signOut).mockResolvedValue({ error: { message: 'Network error' } })

        const mockRemoveSession = vi.fn().mockResolvedValue(undefined)
        vi.mocked(supabase.auth as any)._removeSession = mockRemoveSession

        await signOut()

        expect(supabase.auth.signOut).toHaveBeenCalled()
        expect(mockRemoveSession).toHaveBeenCalled()
    })
})

describe('getProfile', () => {
    it('returns user profile data on success', async () => {
        const mockProfile = { id: 'user-789', username: 'testuser', display_name: 'Test User', avatar_url: null, timezone: 'America/New_York' }
        vi.mocked(supabase.from).mockReturnValue({
            select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                    data: mockProfile,
                    error: null,
                }),
            }),
        })

        const result = await getProfile('user-789')

        expect(supabase.from()).toHaveBeenCalledWith('profiles')
        expect(result).toEqual(mockProfile)
    })

    it('throws error when profile fetch fails', async () => {
        vi.mocked(supabase.from).mockReturnValue({
            select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                    data: null,
                    error: { message: 'Profile not found' },
                }),
            }),
        })

        await expect(getProfile('user-789')).rejects.toThrow('Profile not found')
    })

    it('throws error when from chain fails', async () => {
        vi.mocked(supabase.from).mockReturnValue({
            select: vi.fn().mockRejectedValue(new Error('Database error')),
        })

        await expect(getProfile('user-789')).rejects.toThrow('Database error')
    })
})

describe('updateProfile', () => {
    it('updates display name successfully', async () => {
        vi.mocked(supabase.from).mockReturnValue({
            update: vi.fn().mockResolvedValue({ error: null }),
        })

        const result = await updateProfile('user-789', { display_name: 'Updated Name' })

        expect(supabase.from()).toHaveBeenCalledWith('profiles')
        expect(supabase.from()).toHaveBeenCalledWith('eq', 'id', 'user-789')
        const updateCall = vi.mocked(supabase.from).mock.calls[0]
        const args = (updateCall as any)[1] ?? {}
        expect(args.updated_at).toBeInstanceOf(Date)
    })

    it('throws error when update fails', async () => {
        vi.mocked(supabase.from).mockReturnValue({
            update: vi.fn().mockResolvedValue({ error: { code: '42501', message: 'Update failed' } }),
        })

        await expect(updateProfile('user-789', { display_name: 'New Name' }))
            .rejects.toThrow('Update failed')
    })

    it('throws error when from chain fails before update', async () => {
        vi.mocked(supabase.from).mockReturnValue({
            update: vi.fn().mockRejectedValue(new Error('Network error')),
        })

        await expect(updateProfile('user-789', { display_name: 'New Name' }))
            .rejects.toThrow('Network error')
    })
})
