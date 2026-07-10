import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    upload: vi.fn(),
    update: vi.fn(),
    getPublicUrl: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
    supabase: {
        from: vi.fn(() => ({
            update: mocks.update,
        })),
        storage: {
            from: vi.fn(() => ({
                upload: mocks.upload,
                getPublicUrl: mocks.getPublicUrl,
            })),
        },
    },
}))
vi.mock('@/lib/push-token', () => ({ unregisterCurrentDevicePushToken: vi.fn() }))
vi.mock('@/lib/persistent-cache', () => ({ clearPersistentCaches: vi.fn() }))

import { uploadAvatar } from '@/lib/auth'

beforeEach(() => {
    vi.clearAllMocks()
    mocks.upload.mockResolvedValue({ error: null })
    mocks.getPublicUrl.mockReturnValue({ data: { publicUrl: 'https://cdn.example/avatar.png' } })
    const eq = vi.fn(async () => ({ error: null }))
    mocks.update.mockReturnValue({ eq })
})

describe('avatar upload validation', () => {
    it('uses decoded MIME type for a safe fixed object path', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            new Blob(['image'], { type: 'image/png' }),
            { status: 200 },
        )))

        await uploadAvatar('user-1', { uri: 'blob:https://app.example/opaque-id' })

        expect(mocks.upload).toHaveBeenCalledWith(
            'user-1/avatar.png',
            expect.any(Blob),
            { upsert: true, contentType: 'image/png' },
        )
    })

    it('rejects unsupported and oversized payloads before storage', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            blob: async () => ({ type: 'image/svg+xml', size: 100 }),
        })))
        await expect(uploadAvatar('user-1', { uri: 'blob:svg' })).rejects.toThrow('JPEG, PNG, or WebP')

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            blob: async () => ({ type: 'image/jpeg', size: 5 * 1024 * 1024 + 1 }),
        })))
        await expect(uploadAvatar('user-1', { uri: 'blob:large' })).rejects.toThrow('smaller than 5 MB')
        expect(mocks.upload).not.toHaveBeenCalled()
    })
})
