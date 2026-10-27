import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearEditorDraft, readEditorDraft, saveEditorDraft } from '@/lib/editor-draft'
import { isClaimDraft } from '@/lib/claim-draft'
import { isLineupDraft } from '@/lib/lineup-draft'
import { readTradeComposerDraft, saveTradeComposerDraft } from '@/lib/trade-composer-draft'
import { clearSessionCaches } from '@/lib/session-cache-registry'

let values: Map<string, string>
beforeEach(() => {
    values = new Map()
    vi.stubGlobal('sessionStorage', {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() { return values.size },
    })
})
afterEach(() => vi.unstubAllGlobals())
const draft = { bid: '17', dropPlayerId: 'mine', toIr: false, toTaxi: true }
it('restores only the exact account, league, season and target scope', () => {
    const owner = JSON.stringify(['user', 'league', 'season', 'claim'])
    expect(saveEditorDraft('claim', owner, draft)).toBe(true)
    expect(readEditorDraft('claim', owner, isClaimDraft)).toEqual(draft)
    expect(readEditorDraft('claim', JSON.stringify(['other', 'league', 'season', 'claim']), isClaimDraft)).toBeNull()
    expect(values.size).toBe(0)
})
it('does not let old cleanup erase a newer draft', () => {
    saveEditorDraft('claim', 'new-owner', draft)
    clearEditorDraft('claim', 'old-owner')
    expect(readEditorDraft('claim', 'new-owner', isClaimDraft)).toEqual(draft)
})
it('clears drafts when session ownership ends', () => {
    saveEditorDraft('claim', 'owner', draft)
    clearSessionCaches()
    expect(values.size).toBe(0)
})
it('keeps recovery blocked when storage fails', () => {
    vi.stubGlobal('sessionStorage', { setItem: () => { throw new Error('Storage full') } })
    expect(saveEditorDraft('claim', 'owner', draft)).toBe(false)
})
it('rejects malformed claim and lineup selections', () => {
    saveEditorDraft('claim', 'owner', { ...draft, bid: '17xyz' })
    expect(readEditorDraft('claim', 'owner', isClaimDraft)).toBeNull()
    expect(isLineupDraft({ selection: { kind: 'bench', index: -1 }, playerId: 'player' })).toBe(false)
    expect(isLineupDraft({ selection: { kind: 'bench', index: 0 }, playerId: 'player' })).toBe(true)
})

it('rejects trade drafts whose season cannot be proved current', () => {
    const trade = { ownerIdentity: 'owner', mode: 'propose', sourceTradeId: null, multiTeamMode: false, selectedRecipientId: null, participantIds: [], items: [], notes: 'Unsent', expirationDays: '3', rosterPlan: { taxiPlayerIds: [], irPlayerIds: [], dropPlayerIds: [] } }
    saveTradeComposerDraft(JSON.stringify(trade))
    expect(readTradeComposerDraft('owner', 'propose', null, 'current')).toBeNull()
    saveTradeComposerDraft(JSON.stringify({ ...trade, seasonId: 'previous' }))
    expect(readTradeComposerDraft('owner', 'propose', null, 'current')).toBeNull()
    saveTradeComposerDraft(JSON.stringify({ ...trade, seasonId: 'current' }))
    expect(readTradeComposerDraft('owner', 'propose', null, 'current')?.notes).toBe('Unsent')
})
