import { beforeEach, expect, it, vi } from 'vitest'
import { submitWaiverClaim, editWaiverClaim } from '@/lib/waivers'
const mocks = vi.hoisted(() => ({ post: vi.fn(), read: vi.fn(), from: vi.fn() }))
vi.mock('@/lib/shared/api', () => ({ apiPost: mocks.post }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: mocks.from } }))
beforeEach(() => {
    vi.clearAllMocks()
    const query = { select: vi.fn(), eq: vi.fn(), single: mocks.read }
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query)
    mocks.from.mockReturnValue(query)
    mocks.read.mockResolvedValue({ data: { to_ir: true }, error: null })
})
it('sends direct IR preference in the claim body', async () => {
    await submitWaiverClaim('member', 'league', 'player', undefined, { toIr: true })
    expect(mocks.post).toHaveBeenCalledWith('/waivers/claims', expect.objectContaining({ toIr: true, dropPlayerId: null }))
})
it('preserves stored IR preference when an older editor changes a bid or drop', async () => {
    await editWaiverClaim('claim', 'member', { dropPlayerId: null, bidAmount: 5 })
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/waivers/claims/claim/edit', { memberId: 'member', dropPlayerId: null, bidAmount: 5, claimOrder: null })
})
it('honors an explicit changed IR preference without an extra read', async () => {
    await editWaiverClaim('claim', 'member', { dropPlayerId: null, toIr: false })
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.post).toHaveBeenCalledWith('/waivers/claims/claim/edit', expect.objectContaining({ toIr: false }))
})
it('edits without depending on an obsolete preference read', async () => {
    mocks.read.mockResolvedValue({ data: null, error: new Error('offline') })
    await editWaiverClaim('claim', 'member', { dropPlayerId: null })
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.post).toHaveBeenCalledOnce()
})
