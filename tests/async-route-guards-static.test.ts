import { describe, expect, it } from 'vitest'
import { read } from './source-guard'

describe('async route and league switch guards', () => {
    it('drops stale trades and trade-block loads before committing state', () => {
        const source = read('app/(tabs)/trades.tsx')
        const tradeRequestIndex = source.indexOf('const requestId = ++tradesLoadSeqRef.current')
        const tradeFetchIndex = source.indexOf('await Promise.all', tradeRequestIndex)
        const tradeGuardIndex = source.indexOf('if (tradesLoadSeqRef.current !== requestId) return', tradeFetchIndex)
        const tradeCommitIndex = source.indexOf('setTrades(result)', tradeGuardIndex)

        expect(tradeRequestIndex).toBeGreaterThan(-1)
        expect(tradeGuardIndex).toBeGreaterThan(tradeFetchIndex)
        expect(tradeGuardIndex).toBeLessThan(tradeCommitIndex)
        expect(source).toContain('if (tradesLoadSeqRef.current === requestId) setLoading(false)')

        const blockRequestIndex = source.indexOf('const requestId = ++blockLoadSeqRef.current')
        const blockFetchIndex = source.indexOf('await Promise.all', blockRequestIndex)
        const blockGuardIndex = source.indexOf('if (blockLoadSeqRef.current !== requestId) return', blockFetchIndex)
        const blockCommitIndex = source.indexOf('setBlockItems(items)', blockGuardIndex)

        expect(blockRequestIndex).toBeGreaterThan(-1)
        expect(blockGuardIndex).toBeGreaterThan(blockFetchIndex)
        expect(blockGuardIndex).toBeLessThan(blockCommitIndex)
        expect(source).toContain('if (blockLoadSeqRef.current === requestId) setBlockLoading(false)')
    })

    it('guards player-detail and transaction-history route fetches', () => {
        const source = read('hooks/use-player-screen-data.ts')
        const playerRequestIndex = source.indexOf('const requestId = ++playerRequestRef.current')
        const playerFetchIndex = source.indexOf('const [p, seasons, todayStats] = await Promise.all')
        const playerGuardIndex = source.indexOf('if (playerRequestRef.current !== requestId) return', playerFetchIndex)
        const playerCommitIndex = source.indexOf('setPlayedToday(didPlayToday)', playerGuardIndex)

        expect(playerRequestIndex).toBeGreaterThan(-1)
        expect(playerGuardIndex).toBeGreaterThan(playerFetchIndex)
        expect(playerGuardIndex).toBeLessThan(playerCommitIndex)
        expect(source).toContain('if (playerRequestRef.current === requestId) setLoading(false)')

        const txRequestIndex = source.indexOf('const requestId = ++transactionRequestRef.current')
        const txFetchIndex = source.indexOf('await getPlayerTransactionHistory')
        const txGuardIndex = source.indexOf('if (transactionRequestRef.current !== requestId) return', txFetchIndex)
        const txCommitIndex = source.indexOf('setTransactions(tx)', txGuardIndex)

        expect(txRequestIndex).toBeGreaterThan(-1)
        expect(txGuardIndex).toBeGreaterThan(txFetchIndex)
        expect(txGuardIndex).toBeLessThan(txCommitIndex)
    })

    it('resets and guards claim-player route loads before enabling submit', () => {
        const source = read('app/(modals)/claim-player.tsx')
        const requestIndex = source.indexOf('const requestId = ++claimLoadSeqRef.current')
        const fetchIndex = source.indexOf('const [p, roster, prio, txState] = await Promise.all')
        const guardIndex = source.indexOf('if (claimLoadSeqRef.current !== requestId) return', fetchIndex)
        const commitIndex = source.indexOf('setPlayer(p)', guardIndex)

        expect(requestIndex).toBeGreaterThan(-1)
        expect(source).toContain('setPlayer(null)')
        expect(source).toContain('setMyRoster([])')
        expect(source).toContain('setSelectedDrop(null)')
        expect(guardIndex).toBeGreaterThan(fetchIndex)
        expect(guardIndex).toBeLessThan(commitIndex)
        expect(source).toContain('if (loading || !player) return')
        expect(source).toContain("router.replace('/(tabs)/roster')")
    })
})
