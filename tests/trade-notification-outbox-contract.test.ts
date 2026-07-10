import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('transactional trade notification coverage', () => {
    it('routes every trade action through database-owned outbox triggers', () => {
        const edge = read('supabase/functions/api/trades.ts')
        const statusTrigger = read('supabase/sql/functions/by-name/private/enqueue_trade_status_notification.sql')
        const participantTrigger = read('supabase/sql/functions/by-name/private/enqueue_trade_participant_notification.sql')

        expect(edge).not.toContain('notifyMember')
        for (const event of ['trade_rejected', 'trade_withdrawn', 'trade_expired', 'trade_vetoed', 'trade_completed']) {
            expect(statusTrigger).toContain(`'${event}'`)
        }
        for (const event of ['trade_offered', 'trade_countered', 'trade_edited', 'trade_participant_accepted', 'trade_accepted']) {
            expect(participantTrigger).toContain(`'${event}'`)
        }
    })

    it('separates global receipt releases from per-ticket attempt accounting', () => {
        const edge = read('supabase/functions/process-trades/index.ts')

        expect(edge).toContain('releaseReceipt')
        expect(edge).toContain('deferReceiptState(row, receiptError, false)')
        expect(edge).toContain('deferReceiptState(row, receiptError, true)')
        expect(edge).toContain('p_increment_attempt: incrementAttempt')
        expect(edge).toContain("case 'dead_lettered'")
    })
})
