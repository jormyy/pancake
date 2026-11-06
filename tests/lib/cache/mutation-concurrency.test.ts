import { expect, it } from 'vitest'
import { runCompletionRace } from '../../helpers/mutation-completion-race'
import type { QueuedMutation } from '@/lib/cache/mutation-queue'

it('retains independent completion records when two tabs finish together', async () => {
    const records: QueuedMutation[] = ['A', 'B'].map((accountId, index) => ({
        id: `10000000-0000-4000-8000-00000000000${index + 1}`, accountId, leagueId: null,
        rowIds: [], path: '/action', body: '{}', status: 'pending', error: null, createdAt: 0,
    }))
    const result = await runCompletionRace(records)
    console.log(JSON.stringify(result))
    expect(result.retained).toHaveLength(2)
    expect(result.duplicates).toBe(0)
})
