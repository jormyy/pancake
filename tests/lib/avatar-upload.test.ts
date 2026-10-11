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

        await uploadAvatar('user-1', { uri: 'blob:https://app.example/opaque-id', width: 128, height: 128 })

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
        await expect(uploadAvatar('user-1', { uri: 'blob:svg', width: 128, height: 128 })).rejects.toThrow('JPEG, PNG, or WebP')

        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            blob: async () => ({ type: 'image/jpeg', size: 5 * 1024 * 1024 + 1 }),
        })))
        await expect(uploadAvatar('user-1', { uri: 'blob:large', width: 128, height: 128 })).rejects.toThrow('smaller than 5 MB')
        expect(mocks.upload).not.toHaveBeenCalled()
    })

    it.each([[0, 0], [0, 128], [128, 0], [-1, 128], [NaN, 128], [128, Infinity]])(
        'preserves the saved avatar when decoded dimensions are %s by %s', async (width, height) => {
            const fetchImage = vi.fn()
            vi.stubGlobal('fetch', fetchImage)

            await expect(uploadAvatar('user-1', { uri: 'blob:broken', width, height }))
                .rejects.toThrow('Could not read the selected image. Choose another photo.')

            expect(fetchImage).not.toHaveBeenCalled()
            expect(mocks.upload).not.toHaveBeenCalled()
            expect(mocks.update).not.toHaveBeenCalled()
        },
    )
})
