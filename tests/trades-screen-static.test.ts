import { describe, expect, it } from 'vitest'
import { latestFunctionDefinition, read } from './source-guard'

const tradesScreen = read('app/(tabs)/trades.tsx')
const tradesApi = read('supabase/functions/api/trades.ts')

describe('trades screen static behavior', () => {
    it('separates owned trade-block management from the league block tab', () => {
        expect(tradesScreen).toContain("const myBlockItems = useMemo(")
        expect(tradesScreen).toContain('blockItems.filter((item) => item.memberId === myMemberId)')
        expect(tradesScreen).toContain("{ label: 'Your Block', value: 'block' }")
        expect(tradesScreen).toContain("{ label: 'League Block', value: 'leagueBlock' }")
        expect(tradesScreen).toContain("result.push({ _type: 'header', label: 'Your Listings' })")
        expect(tradesScreen).toContain("result.push({ _type: 'header', label: 'League Trade Block' })")
        expect(tradesScreen).toContain("result.push({ _type: 'empty', key: 'my-block-listings', message: 'No listings yet.' })")
        expect(tradesScreen).toContain("result.push({ _type: 'empty', key: 'league-block-listings', message: 'No league listings yet.' })")
        expect(tradesScreen).toContain("tab === 'leagueBlock'")
        expect(tradesScreen).toContain('blockItems.forEach((item) => result.push({ _type: \'blockItem\', item }))')
        expect(tradesScreen).toContain("<Text style={styles.blockActionText}>Yours</Text>")
    })

    it('keeps trade-block mutations owner-only through API and RPC guards', () => {
        expect(tradesApi).toContain("const { leagueId } = await requireOwnMember(userId, memberId)")
        expect(tradesApi).toContain("if (requestedLeagueId !== leagueId) throw new ValidationError('Access denied')")
        expect(tradesApi).toContain("await requireOwnMember(userId, memberId)")
        expect(tradesApi).toContain("supabase.rpc('add_trade_block_item_atomic'")
        expect(tradesApi).toContain("supabase.rpc('remove_trade_block_item_atomic'")

        const addBody = latestFunctionDefinition('add_trade_block_item_atomic')
        const removeBody = latestFunctionDefinition('remove_trade_block_item_atomic')
        expect(addBody).toContain('AND (p_user_id IS NULL OR user_id = p_user_id)')
        expect(addBody).toContain('Only active roster players can be listed on the trade block.')
        expect(addBody).toContain('Only picks you own can be listed on the trade block.')
        expect(removeBody).toContain('IF v_item.member_id <> p_member_id THEN')
        expect(removeBody).toContain('Only the listing manager can remove this trade block item.')
    })
})
